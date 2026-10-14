import type { ContentAsset, ContentProgress, ProcessingMode,ContentKind } from "./content-types.js";
export function parseProcessingMode(value:unknown, fallback:ProcessingMode="full"):ProcessingMode {
  if(value===undefined)return fallback;
  if(value!=="original"&&value!=="transcribe"&&value!=="full")throw new Error("处理选项可选 original（原件）、transcribe（文字稿）、full（关键帧及图片识别）");
  return value;
}
export function requestedProcessingAsset(asset:ContentAsset,mode:ProcessingMode="full",kind?:ContentKind):boolean {
  if(mode==="full"||asset.provenance==="original"||asset.provenance==="user_edited")return true;
  if(asset.role==="frame")return false;
  if(asset.role==="ocr")return mode==="transcribe"&&kind!==undefined&&kind!=="video";
  return mode!=="original"||!(["machine_asr","machine_ocr","platform_subtitle"].includes(asset.provenance??"")||asset.role==="transcript"||(asset.role==="audio"&&asset.provenance==="generated"));
}
/** A count describes a single phase; it is never an invented overall completion percentage. */
export function normalizedProgress(progress:ContentProgress):ContentProgress {
  const {completed,total}=progress;
  const valid=completed!==undefined&&total!==undefined&&Number.isSafeInteger(completed)&&Number.isSafeInteger(total)&&total>0&&completed>=0&&completed<=total;
  return {phase:progress.phase.slice(0,200),...(valid?{completed,total,unit:progress.unit?.slice(0,40)}:{})};
}
export function assetAction(asset:ContentAsset):string {
  if(asset.status==="saved")return "可打开本地文件";
  if(/HTTP\s*429|请求过于频繁/.test(asset.reason??""))return "停止连续重试，稍后再试；可在登录与依赖页检查YouTube网络设置，平台要求验证时使用专用浏览器";
  if(asset.status==="login_required")return "在登录与依赖页打开该平台专用浏览器，完成登录或验证后重试";
  if(asset.status==="missing_dependency")return "在登录与依赖页检查并安装缺少的工具，再重试";
  if(asset.status==="unavailable")return "打开来源确认内容仍可访问；恢复可访问后重试";
  if(asset.status==="skipped")return "如需此项，选择完整处理后重试";
  return "查看原因；修正网络、依赖或源文件问题后重试";
}
