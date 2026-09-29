/**
 * 通信层基础接口
 * ------------------------------------------------------------
 * 这就是"主通信接口"的两个基类：
 *   ChannelAdapter —— 任何新通道（电话/短信/飞书/微信/钉钉…）都继承它，实现 send()，
 *                     需要额外能力再实现 probe() / supports()。
 *   ChannelRegistry —— 通道注册表，按 kind 查找。
 * 上层（CommModule）只依赖这两个抽象，不认识任何具体厂商接口。
 */

export class ChannelAdapter {
  /**
   * @param {string} name 适配器实例名（唯一）
   * @param {{label?:string, description?:string}} [opts]
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.label = opts.label || name;
    this.description = opts.description || "";
  }

  /** 通道类型：phone / webhook / sms / feishu …，信号里的 kind 与它对应 */
  get kind() {
    throw new Error(`${this.name}: 适配器必须实现 kind`);
  }

  /** 该通道支持的扩展能力，例如 "voice" / "text" / "markdown" */
  supports(_feature) {
    return false;
  }

  /**
   * 真正发送
   * @param {{title:string, content:string, source:string, meta:object}} payload
   * @param {{config:object, store:object, log:object, env:object}} ctx
   * @returns {Promise<{ok:boolean, retryable?:boolean, reason?:string, detail?:string, requestId?:string, raw?:any}>}
   */
  async send(_payload, _ctx) {
    throw new Error(`${this.name}: 适配器必须实现 send()`);
  }

  /**
   * 健康自检：只验证"能不能连上/凭据格式对不对"，不产生真实通知。
   * 不实现则返回未支持。
   */
  async probe(_ctx) {
    return { ok: true, supported: false, detail: "该通道未实现自检" };
  }

  /** 给界面看的信息 */
  describe() {
    return { name: this.name, kind: this.kind, label: this.label, description: this.description };
  }
}

export class ChannelRegistry {
  constructor() {
    this.map = new Map();
  }

  register(adapter) {
    if (!(adapter instanceof ChannelAdapter)) {
      throw new Error("register() 只接受 ChannelAdapter 实例");
    }
    this.map.set(adapter.kind, adapter);
    this.map.set(adapter.name, adapter);
    return adapter;
  }

  /** 按 kind 或 name 查找 */
  get(key) {
    return this.map.get(String(key || "").toLowerCase()) || this.map.get(key) || null;
  }

  has(key) {
    return Boolean(this.get(key));
  }

  /** 去重后的适配器列表 */
  list() {
    return [...new Set(this.map.values())];
  }
}
