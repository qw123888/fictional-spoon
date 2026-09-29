"""
电话通知桥接模块（监听器 → 电话通知网站）
============================================================
这是"电脑发出信号"这一端的**唯一接口**：监听器内部任何地方要打电话，
都只调用 NotifyBridge.on_message() / notify()，不直接拼 HTTP 请求。

设计要点
--------
1. 异步入队：on_message() 立刻返回，发送在后台线程做，绝不阻塞监控轮询。
2. 永不抛异常：桥接挂了最多是打不出电话，不能让监听器跟着崩。
3. 纯 stdlib + requests：不引入新依赖。
4. 配置来自 config.json 的 "notify" 段，缺省时整个模块自动禁用。

config.json 片段示例
-------------------
"notify": {
    "enabled": true,
    "site_url": "https://phone-notify.你的域名.workers.dev",
    "token": "你在网站上设置的访问令牌",
    "timeout": 8,
    "retry": 1,
    "title_template": "{source_label}新消息",
    "content_template": "#{channel} {author}: {content}",
    "content_limit": 120,
    "sources": ["discord"],
    "min_interval": 0
}

命令行自测
---------
py -3 notify_bridge.py --test                       # 打一通测试电话
py -3 notify_bridge.py --signal "标题" "内容"        # 发一条测试信号
py -3 notify_bridge.py --status                     # 查看网站状态
"""

from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
import time
from datetime import datetime
from typing import Any, Callable, Optional

import requests

SOURCE_LABELS = {
    "discord": "Discord",
    "telegram": "Telegram",
    "tg": "Telegram",
    "feishu": "飞书",
    "manual": "手动",
    "test": "测试",
}

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "site_url": "http://127.0.0.1:8787",
    "token": "",
    "timeout": 8,
    "retry": 1,
    "queue_size": 200,
    "content_limit": 120,
    "title_template": "{source_label}新消息",
    "content_template": "#{channel} {author}: {content}",
    "sources": ["discord"],
    "min_interval": 0,
    "use_proxy": False,
}


class NotifyBridge:
    """监听器与电话通知网站之间的信号桥。"""

    def __init__(self, config: Optional[dict] = None, log_fn: Optional[Callable[[str, str], None]] = None,
                 proxies: Optional[dict] = None):
        cfg = dict(DEFAULT_CONFIG)
        cfg.update({k: v for k, v in (config or {}).items() if v is not None})
        self.cfg = cfg
        self._log_fn = log_fn
        # 默认直连通知网站；notify.use_proxy=true 时复用 config.json 的 proxy 段
        self._proxies = dict(proxies) if (proxies and cfg.get("use_proxy")) else None
        self._queue: "queue.Queue[dict]" = queue.Queue(maxsize=int(cfg.get("queue_size", 200)))
        self._stop = threading.Event()
        self._last_sent = 0.0
        self.stats = {"queued": 0, "sent": 0, "failed": 0, "skipped": 0, "dropped": 0}
        self._lock = threading.Lock()
        self._worker: Optional[threading.Thread] = None
        if self.enabled:
            self._start_worker()

    # ---------- 构造 ----------
    @classmethod
    def from_config(cls, config: dict, log_fn: Optional[Callable[[str, str], None]] = None) -> "NotifyBridge":
        """从监听器的整份 config.json 里取 notify 段构造实例。"""
        section = (config or {}).get("notify", {}) or {}
        return cls(section, log_fn=log_fn, proxies=(config or {}).get("proxy"))

    @property
    def enabled(self) -> bool:
        return bool(self.cfg.get("enabled"))

    # ---------- 日志 ----------
    def _log(self, text: str, tag: str = "info"):
        if self._log_fn:
            try:
                self._log_fn(text, tag)
                return
            except Exception:
                pass
        print(f"[notify_bridge] {text}")

    # ---------- 对外接口 ----------
    def on_message(self, event: dict) -> None:
        """
        监听器消息事件的统一入口（Discord / Telegram 都往这里丢）。
        event 建议字段：
            {"source":"discord", "channel":"频道名", "author":"作者",
             "content":"消息正文", "id":"消息ID", "images":0}
        """
        if not self.enabled:
            return
        source = str(event.get("source", "discord")).lower()
        allowed = [str(s).lower() for s in (self.cfg.get("sources") or [])]
        if allowed and source not in allowed:
            with self._lock:
                self.stats["skipped"] += 1
            return
        self.notify(
            title=self._render(self.cfg["title_template"], event, source),
            content=self._render(self.cfg["content_template"], event, source),
            source=source,
            msg_id=str(event.get("id", "") or ""),
        )

    def notify(self, title: str, content: str = "", source: str = "manual",
               msg_id: str = "", force: bool = False) -> bool:
        """把一条通知排进队列。返回 False 表示没进队（未启用/本机限流/队列满）。"""
        if not self.enabled and not force:
            return False

        min_interval = float(self.cfg.get("min_interval", 0) or 0)
        if min_interval > 0 and not force:
            if time.time() - self._last_sent < min_interval:
                with self._lock:
                    self.stats["skipped"] += 1
                return False

        signal = {
            "kind": "phone",
            "title": (title or "通知")[:200],
            "content": (content or "")[:2000],
            "source": source,
            "id": msg_id,
            "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
            "force": bool(force),
        }
        try:
            self._queue.put_nowait(signal)
            with self._lock:
                self.stats["queued"] += 1
            self._last_sent = time.time()
            return True
        except queue.Full:
            with self._lock:
                self.stats["dropped"] += 1
            self._log("电话通知队列已满，丢弃一条信号", "warn")
            return False

    def test(self, title: str = "监听器测试电话", content: str = "") -> dict:
        """同步打一通测试电话（force，绕过网站的时间段与去重）。"""
        if not content:
            content = f"来自监听器的测试通话，{datetime.now().strftime('%m-%d %H:%M:%S')}"
        return self._request("/api/test-call", {"title": title, "content": content})

    def send_signal(self, title: str, content: str = "", source: str = "manual", force: bool = False) -> dict:
        """同步发一条普通信号（会走网站的时间段/去重规则，除非 force）。"""
        return self._request("/api/signal", {
            "kind": "phone", "title": title, "content": content,
            "source": source, "force": force,
        })

    def status(self) -> dict:
        """查询网站状态（不需要令牌）。"""
        return self._request("/api/health", None, method="GET")

    def close(self):
        self._stop.set()

    # ---------- 内部 ----------
    def _render(self, template: str, event: dict, source: str) -> str:
        data = {
            "source": source,
            "source_label": SOURCE_LABELS.get(source, source),
            "channel": str(event.get("channel", "") or ""),
            "author": str(event.get("author", "") or ""),
            "content": str(event.get("content", "") or ""),
            "images": event.get("images", 0),
        }
        try:
            text = str(template).format(**data)
        except (KeyError, IndexError, ValueError):
            text = data["content"]
        limit = int(self.cfg.get("content_limit", 120) or 120)
        return " ".join(text.split())[:limit]

    def _start_worker(self):
        self._worker = threading.Thread(target=self._loop, name="notify-bridge", daemon=True)
        self._worker.start()

    def _loop(self):
        while not self._stop.is_set():
            try:
                signal = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            result = self._request("/api/signal", signal)
            with self._lock:
                if result.get("ok"):
                    self.stats["sent"] += 1
                elif result.get("skipped"):
                    self.stats["skipped"] += 1
                else:
                    self.stats["failed"] += 1
            if result.get("ok"):
                self._log(f"电话通知已发出: {signal['title']}", "ok")
            elif result.get("skipped"):
                self._log(f"电话通知被网站跳过（{result.get('reason', '')}）：{result.get('detail', '')}", "info")
            else:
                self._log(f"电话通知失败（{result.get('reason', '')}）：{result.get('detail', '')}", "warn")

    def _request(self, path: str, payload: Optional[dict], method: str = "POST") -> dict:
        url = str(self.cfg.get("site_url", "")).rstrip("/") + path
        if not url.startswith("http"):
            return {"ok": False, "reason": "bad_url", "detail": f"网站地址无效: {url}"}
        headers = {"Content-Type": "application/json"}
        token = str(self.cfg.get("token", "") or "")
        if token:
            headers["X-Auth-Token"] = token
        retry = int(self.cfg.get("retry", 1) or 0)
        timeout = float(self.cfg.get("timeout", 8) or 8)
        last = {"ok": False, "reason": "unknown", "detail": ""}
        for attempt in range(retry + 1):
            try:
                if method == "GET":
                    resp = requests.get(url, headers=headers, timeout=timeout, proxies=self._proxies)
                else:
                    resp = requests.post(url, headers=headers, json=payload, timeout=timeout,
                                         proxies=self._proxies)
                try:
                    data = resp.json()
                except ValueError:
                    data = {}
                if resp.status_code == 401:
                    return {"ok": False, "reason": "unauthorized", "detail": "令牌错误：网站返回 401", "http": 401}
                if isinstance(data, dict) and data:
                    data.setdefault("http", resp.status_code)
                    if data.get("ok") or data.get("skipped"):
                        return data
                    last = data
                else:
                    last = {"ok": False, "reason": f"http_{resp.status_code}", "detail": resp.text[:200]}
            except requests.RequestException as exc:
                last = {"ok": False, "reason": "network", "detail": str(exc)}
            except Exception as exc:  # 任何意外都不许冒泡到监听器
                last = {"ok": False, "reason": "error", "detail": str(exc)}
            if attempt < retry:
                time.sleep(1.0 + attempt)
        return last


# ---------------- 命令行自测 ----------------
def _load_config(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"找不到配置文件: {path}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"配置文件格式错误: {e}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="监听器 → 电话通知网站 桥接自测工具")
    parser.add_argument("--config", default="config.json", help="监听器配置文件路径（默认 config.json）")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--test", action="store_true", help="打一通测试电话")
    group.add_argument("--signal", nargs=2, metavar=("标题", "内容"), help="发一条普通信号")
    group.add_argument("--status", action="store_true", help="查看电话通知网站状态")
    args = parser.parse_args()

    config = _load_config(args.config)
    bridge = NotifyBridge.from_config(config, log_fn=lambda t, tag: print(f"[{tag}] {t}"))

    if not bridge.enabled:
        print("提示：config.json 里 notify.enabled = false，正在以强制模式执行本次命令")

    if args.test:
        result = bridge.test()
    elif args.signal:
        result = bridge.send_signal(args.signal[0], args.signal[1], source="manual")
    else:
        result = bridge.status()

    print(json.dumps(result, ensure_ascii=False, indent=2))
    # skipped（如不在通知时间段）属于正常结果，不算失败
    if not (result.get("ok") or result.get("skipped")):
        sys.exit(2)


if __name__ == "__main__":
    main()
