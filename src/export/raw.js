/**
 * @param {object} ctx
 */
export function toRaw(ctx) {
  return {
    target: ctx.baseUrl.href,
    generatedAt: new Date().toISOString(),
    stats: ctx.stats,
    jsAssets: [...ctx.cache.assets.values()].map((a) => ({
      url: a.url,
      diskPath: a.diskPath,
      byteLength: a.byteLength,
      pageUrls: [...a.pageUrls],
    })),
    sourceMaps: ctx.mapCount,
    reconstructedFiles: ctx.reconstructed.size,
    endpoints: ctx.findings,
    websockets: [...ctx.network.websockets],
    sse: [...ctx.network.sseUrls],
  };
}
