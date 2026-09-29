"""
电脑端拨号执行器（DialExecutor）
============================================================
为什么需要它
------------
Spug 的 App Key 可以绑 IP 白名单。绑了以后，只有白名单里的 IP 能发消息；
Cloudflare Worker 的出口 IP 是共享的、不可指定，永远进不了白名单，于是网站
直接拨号会拿到 spug_403（"请求IP: 162.159.98.122 不在IP白名单内"）。

所以把"最后那一次 HTTP 拨号请求"交给这台电脑来发：出口 IP 就是白名单里的那个。

它在闭环里的位置
----------------
    监听器 → 网站（决定要不要打：总开关 / 时间段 / 防轰炸）
           → outbox 队列
           → 本模块 GET /api/outbox 领任务
           → **直连** Spug 拨号（不走代理！否则出口 IP 变成代理的 IP）
           → POST /api/outbox/result 回报 → 网站写日志 / 健康快照 / 备用通道

接口约定（模块化的那一段）
--------------------------
    executor = DialExecutor(bridge)      # bridge 提供 _request()：带令牌的网站请求
    executor.start()                     # 后台线程轮询（监听器启动时调一次）
    executor.stop()                      # 停止
    executor.poll_once()                 # 同步跑一轮，返回处理条数（自测/脚本用）
    executor.dial_task(task, spug)       # 只拨号，不碰队列

不依赖监听器的任何东西，也不自己读 config.json —— 参数全部从网站 /api/outbox 下发。

命令行自测
----------
    py -3 dial_executor.py --config config.json --once
    py -3 dial_executor.py --config config.json --loop
    py -3 dial_executor.py --config config.json --dial "测试" "内容"
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import time
from typing import Any, Callable, Optional
from urllib.parse import quote

import requests

VERSION = "1.0"

DEFAULT_DIAL: dict[str, Any] = {
    "dial_executor": True,
    "dial_poll_interval": 3,
    "dial_batch": 5,
}


class DialExecutor:
    """向网站领拨号任务，并在本机直连 Spug 拨出去。"""

    def __init__(self, bridge, log_fn: Optional[Callable[[str, str], None]] = None,
                 interval: Optional[float] = None, batch: Optional[int] = None):
        self.bridge = bridge
        cfg = getattr(bridge, "cfg", {}) or {}
        self.enabled = bool(cfg.get("dial_executor", True))
        self.interval = float(interval or cfg.get("dial_poll_interval", 3) or 3)
        self.batch = int(batch or cfg.get("dial_batch", 5) or 5)
        self.host = socket.gethostname()
        self._log_fn = log_fn
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._session_obj: Optional[requests.Session] = None
        self._lock = threading.Lock()
        self.stats = {"polls": 0, "rounds_with_task": 0, "claimed": 0, "ok": 0,
                      "failed": 0, "errors": 0, "last_poll": 0.0}
        self.last_error = ""
        self.last_result: dict = {}

    # ---------- 生命周期 ----------
    def start(self) -> bool:
        if not self.enabled:
            self._log("电脑端拨号执行器未启用（notify.dial_executor = false）", "info")
            return False
        if self._thread and self._thread.is_alive():
            return True
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="dial-executor", daemon=True)
        self._thread.start()
        self._log(f"电脑端拨号执行器已启动（每 {self.interval:g} 秒问一次网站，出口 IP 走本机直连）", "ok")
        return True

    def stop(self):
        self._stop.set()

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def status(self) -> dict:
        with self._lock:
            return {"running": self.running, "enabled": self.enabled, "interval": self.interval,
                    "host": self.host, "last_error": self.last_error, **self.stats}

    # ---------- 主循环 ----------
    def _log(self, text: str, tag: str = "info"):
        if self._log_fn:
            try:
                self._log_fn(text, tag)
                return
            except Exception:
                pass
        bridge_log = getattr(self.bridge, "_log", None)
        if callable(bridge_log):
            try:
                bridge_log(text, tag)
                return
            except Exception:
                pass
        print(f"[dial_executor] {text}")

    def _loop(self):
        while not self._stop.is_set():
            handled = 0
            try:
                handled = self.poll_once()
            except Exception as exc:  # 执行器不许把监听器带崩
                with self._lock:
                    self.stats["errors"] += 1
                self.last_error = str(exc)
                self._log(f"拨号执行器出错（忽略并继续）: {exc}", "warn")
            # 有活干就立刻再问一次（队列可能积压），没活就按间隔睡
            self._stop.wait(0.2 if handled and handled > 0 else self.interval)

    # ---------- 领任务 ----------
    def fetch_outbox(self, limit: Optional[int] = None, claim: bool = True) -> dict:
        """问网站要任务。返回网站的原始响应（dict）。"""
        n = int(limit or self.batch)
        path = (f"/api/outbox?claim={'1' if claim else '0'}&limit={n}"
                f"&host={quote(self.host)}&version={quote(VERSION)}")
        return self.bridge._request(path, None, method="GET")

    def poll_once(self, limit: Optional[int] = None) -> int:
        """同步跑一轮：领一批 → 逐条拨 → 回报。返回本轮处理条数；<0 表示这次问网站失败。"""
        resp = self.fetch_outbox(limit=limit)
        with self._lock:
            self.stats["polls"] += 1
            self.stats["last_poll"] = time.time()
        if not resp.get("ok"):
            self.last_error = f"{resp.get('reason', '')}: {resp.get('detail', '')}"
            self._log(f"问网站要任务失败：{self.last_error}", "warn")
            return -1

        mode = str(resp.get("mode") or "site")
        spug = resp.get("spug") or {}
        tasks = resp.get("tasks") or []
        if mode != "pc":
            # 网站还在"网站自己拨"模式：执行器闲着就行（不用报错，用户可能故意切回去）
            return 0
        if not tasks:
            return 0

        with self._lock:
            self.stats["claimed"] += len(tasks)
            self.stats["rounds_with_task"] += 1
        for task in tasks:
            result = self.dial_task(task, spug)
            self.last_result = result
            self._report(task, result)
        return len(tasks)

    # ---------- 拨号（直连，绝不走代理）----------
    def _session(self) -> requests.Session:
        if self._session_obj is None:
            s = requests.Session()
            # 关键：忽略 HTTP_PROXY/HTTPS_PROXY 等环境变量。
            # 一旦走代理，出口 IP 就变成代理的，Spug 白名单照样拒。
            s.trust_env = False
            self._session_obj = s
        return self._session_obj

    def dial_task(self, task: dict, spug: dict) -> dict:
        """按网站的拨号参数真拨一通电话。返回 {ok, reason, detail, requestId, ms, status}。"""
        t0 = time.time()
        base = str((spug or {}).get("baseUrl") or "https://push.spug.cc").rstrip("/")
        key = str((spug or {}).get("appKey") or "").strip()
        if not key:
            return {"ok": False, "reason": "no_app_key", "detail": "网站没下发 App Key（检查 Cloudflare Secret SPUG_APP_KEY）", "ms": 0}

        limit = int((spug or {}).get("contentLimit") or 120)
        body: dict[str, Any] = {
            "title": str(task.get("title") or "通知")[:32],
            "type": "text",
            "content": str(task.get("content") or "")[:limit],
        }
        targets = str((spug or {}).get("targets") or "").strip()
        if targets:
            body["targets"] = targets
        else:
            body["channel"] = str((spug or {}).get("channel") or "voice")

        timeout = max(1.0, float((spug or {}).get("timeoutMs") or 15000) / 1000.0)
        url = f"{base}/xsend/{quote(key, safe='')}"
        try:
            resp = self._session().post(url, json=body, timeout=timeout,
                                        proxies={"http": None, "https": None})
        except requests.RequestException as exc:
            return {"ok": False, "reason": "network", "detail": str(exc), "ms": int((time.time() - t0) * 1000)}

        ms = int((time.time() - t0) * 1000)
        try:
            data = resp.json()
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        code = data.get("code")
        request_id = str(data.get("request_id") or data.get("requestId") or "")
        msg = str(data.get("msg") or data.get("message") or "").strip() or str(resp.text)[:200]

        if resp.status_code == 403 or code == 403:
            return {"ok": False, "reason": "spug_403", "http": resp.status_code, "ms": ms,
                    "detail": f"{msg}｜这台电脑的出口 IP 需要加进 Spug 白名单（个人设置 → IP 白名单）"}
        if not (resp.ok and code == 200):
            return {"ok": False, "reason": f"spug_{code if code is not None else resp.status_code}",
                    "detail": msg, "ms": ms, "requestId": request_id, "http": resp.status_code}

        # 平台受理 ≠ 真的拨通了：撞上流控时 /xsend 照样回 code 200，
        # 只有按 request_id 去 /request/query 才看得到 status（2=成功，3=被限流）。
        status = None
        detail = "平台已受理"
        dev_token = str((spug or {}).get("devToken") or "").strip()
        if request_id and dev_token:
            q = self.query_status(base, dev_token, request_id, timeout)
            status = q.get("status")
            detail = q.get("detail") or detail
        ok = status is None or status == 2
        reason = "sent" if ok else f"spug_status_{status}"
        return {"ok": ok, "reason": reason, "detail": detail, "ms": ms,
                "requestId": request_id, "status": status, "http": resp.status_code}

    def query_status(self, base: str, dev_token: str, request_id: str, timeout: float) -> dict:
        """按 request_id 复核真实发送状态。失败也不抛异常，返回 {status, detail}。"""
        try:
            resp = self._session().post(f"{base}/request/query", json={"token": dev_token, "request_id": request_id},
                                        timeout=timeout, proxies={"http": None, "https": None})
            data = resp.json()
        except Exception as exc:
            return {"status": None, "detail": f"状态复核失败（{exc}），以平台受理为准"}
        items = data.get("data") if isinstance(data, dict) else None
        if isinstance(items, dict):
            items = [items]
        if not isinstance(items, list) or not items:
            return {"status": None, "detail": "平台已受理（查不到状态明细）"}
        item = items[0]
        for it in items:  # 优先看语音通道那条
            if str(it.get("channel") or "") == "voice":
                item = it
                break
        status = item.get("status")
        try:
            status = int(status)
        except (TypeError, ValueError):
            status = None
        text = {2: "已接通", 3: "被平台流控（1 次/分钟、5 次/小时、20 次/天）"}.get(status, f"状态码 {status}")
        return {"status": status, "detail": f"平台状态：{text}"}

    # ---------- 回报结果 ----------
    def _report(self, task: dict, result: dict) -> dict:
        payload = {
            "id": task.get("id"),
            "ok": bool(result.get("ok")),
            "reason": result.get("reason", ""),
            "detail": result.get("detail", ""),
            "requestId": result.get("requestId", ""),
            "ms": result.get("ms", 0),
            "status": result.get("status"),
            "host": self.host,
        }
        resp = self.bridge._request("/api/outbox/result", payload)
        with self._lock:
            if result.get("ok"):
                self.stats["ok"] += 1
            else:
                self.stats["failed"] += 1
        if result.get("ok"):
            self._log(f"电话已拨出（电脑端直连）: {task.get('title', '')} {result.get('detail', '')}".strip(), "ok")
        else:
            self._log(f"电脑端拨号失败 [{result.get('reason', '?')}] {result.get('detail', '')}", "warn")
        if not resp.get("ok"):
            self.last_error = f"回报失败：{resp.get('reason', '')} {resp.get('detail', '')}"
        return resp


# ---------------- 命令行自测 ----------------
def _load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser(description="电脑端拨号执行器（Spug IP 白名单场景）")
    parser.add_argument("--config", default="config.json", help="监听器配置文件路径（默认 config.json）")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--once", action="store_true", help="领一轮任务就退出（没有任务也退出）")
    group.add_argument("--loop", action="store_true", help="前台常驻轮询（Ctrl+C 退出）")
    group.add_argument("--dial", nargs=2, metavar=("标题", "内容"), help="不进队列，直接用本机拨一通测试电话")
    group.add_argument("--status", action="store_true", help="只看队列/执行器状态，不领任务")
    args = parser.parse_args()

    sys.path.insert(0, ".")
    from notify_bridge import NotifyBridge  # noqa: E402  （同目录）

    config = _load_config(args.config)
    bridge = NotifyBridge.from_config(config, log_fn=lambda t, tag: print(f"[{tag}] {t}"))
    ex = DialExecutor(bridge, log_fn=lambda t, tag: print(f"[{tag}] {t}"))

    if args.status:
        resp = ex.fetch_outbox(claim=False)
        print(json.dumps(resp, ensure_ascii=False, indent=2)[:4000])
        return

    if args.dial:
        probe = ex.fetch_outbox(claim=False)
        if not probe.get("ok"):
            print(json.dumps(probe, ensure_ascii=False, indent=2))
            sys.exit(2)
        spug = probe.get("spug") or {}
        print(f"网站模式={probe.get('mode')}　网站看到的我的 IP={probe.get('seenIp')}")
        print(f"Spug={spug.get('baseUrl')}　channel={spug.get('channel')}　AppKey={'有' if spug.get('appKey') else '无'}")
        result = ex.dial_task({"title": args.dial[0], "content": args.dial[1]}, spug)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if result.get("ok") else 2)

    if args.once:
        n = ex.poll_once()
        print(f"本轮处理 {n} 条任务" if n >= 0 else f"失败：{ex.last_error}")
        print(json.dumps(ex.status(), ensure_ascii=False, indent=2))
        return

    ex.interval = max(1.0, ex.interval)
    print("前台常驻轮询中，Ctrl+C 退出…")
    try:
        while True:
            ex.poll_once()
            time.sleep(ex.interval)
    except KeyboardInterrupt:
        print("已退出")


if __name__ == "__main__":
    main()
