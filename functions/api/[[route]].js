/**
 * Cloudflare Pages Functions 适配层
 * ------------------------------------------------------------
 * 如果你用「Pages + 连接 Git 仓库」的方式部署（而不是 wrangler deploy），
 * 这个文件会让 /api/* 走同一份 src/index.js，业务代码零重复。
 * 静态页面由 Pages 自己托管，不需要 ASSETS 绑定。
 */
import { handleApi } from "../../src/index.js";

export const onRequest = async (context) => {
  return await handleApi(context.request, context.env || {});
};
