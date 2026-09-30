/**
 * ============================================================
 *  电脑端拨号派发器 PcDialDispatcher
 * ============================================================
 * 它是通信模块里的一个"出口"，不是通道适配器：
 *   通道适配器（spug_voice / webhook…）自己发 HTTP；
 *   它把拨号任务塞进 outbox，由电脑端执行器（pc/dial_executor.py）发 HTTP。
 *
 * 只在 `phone.dialVia === "pc"` 时被 CommModule 选中。
 * 这样切换拨打方式不用改 CommModule.notify 的流水线：
 *   总开关 / 时间段 / 防轰炸 / 日志 / 健康 / 备用通道 全都留在网站，
 *   只有"最后那一次 fetch"换了执行者。
 *
 * 出口 IP 的意义：Spug 的 App Key 白名单只放行电脑所在网络的出口 IP，
 *              Worker 出口 IP 是 Cloudflare 共享的，加不进白名单。
 */
import { enqueue, executorStatus } from "../core/outbox.js";

export class PcDialDispatcher {
  constructor({ store, log = null } = {}) {
    this.store = store;
    this.log = log;
    this.kind = "phone-pc";
    this.name = "电脑端拨号";
  }

  /**
   * 把一条拨号任务排进队列
   * @param {{title:string, content:string, source?:string, meta?:object}} payload
   * @param {{source?:string, force?:boolean, fingerprint?:string, signalId?:string}} ctx
   */
  async dispatch(payload = {}, ctx = {}) {
    const t0 = Date.now();
    const executor = await executorStatus(this.store);
    const r = await enqueue(this.store, {
      title: payload.title,
      content: payload.content,
      source: ctx.source || payload.source || "unknown",
      force: Boolean(ctx.force),
      fingerprint: ctx.fingerprint || "",
      signalId: ctx.signalId || ""
    });

    const online = executor.online;
    const where = executor.ip ? `，出口 IP ${executor.ip}` : "";
    // 心跳被节流成 5 分钟写一次，所以"在线"判定窗口（EXECUTOR_ONLINE_MS）必须比它大：
    // 否则活得好好的执行器会常年被判成离线，监听器日志就会写"电话通知失败（no_executor）"，
    // 而电话其实几秒后照样拨出去了。
    const seen = executor.lastSeen ? executor.lastSeen.slice(11, 19) : "";
    const age = executor.ageSeconds === null || executor.ageSeconds === undefined
      ? "从未"
      : `${Math.round(Number(executor.ageSeconds) / 60)} 分钟前`;
    return {
      ok: Boolean(r.persisted && online),
      queued: true,
      retryable: false,
      taskId: r.task.id,
      depth: r.depth,
      attempts: 1,
      ms: Date.now() - t0,
      requestId: "",
      reason: !r.persisted ? "queue_not_persisted" : online ? "queued" : "no_executor",
      detail: !r.persisted
        ? "拨号任务没能写进队列（存储不可用，先绑 KV）"
        : online
          ? `已排队，等电脑端拨号（执行器在线${where}，现在 ${r.depth} 条待拨）`
          : `已排队，但电脑端执行器最近没心跳（最后一次 ${seen || "未知"}，约 ${age}${where}）：` +
            `先确认监听器开着、电脑端拨号执行器在跑；它一上线就会把队列里的 ${r.depth} 条拨出去`,
      executor
    };
  }
}
