import type { MediaCandidate } from "./content-photo-media.js";

const pixels = (candidate: MediaCandidate) => Number.isSafeInteger(candidate.width) && Number.isSafeInteger(candidate.height) && candidate.width! > 0 && candidate.height! > 0 && candidate.width! <= 32768 && candidate.height! <= 32768 ? candidate.width! * candidate.height! : 0;
const watermarkOrder = { none: 0, unknown: 1, present: 2 };
const bitrate = (candidate: MediaCandidate) => Number.isFinite(candidate.bitrate) && candidate.bitrate! > 0 ? candidate.bitrate! : 0;

/** Metadata chooses a candidate; only inspecting the saved file can confirm its dimensions. */
export function prioritizeMediaCandidates(candidates: MediaCandidate[]): MediaCandidate[] {
  const unique = new Map<string, MediaCandidate>();
  for (const candidate of candidates.slice(0, 4096)) {
    const prior = unique.get(candidate.url);
    if (!prior) { unique.set(candidate.url, { ...candidate }); continue; }
    // A known watermark declaration cannot be weakened by another alias of the same URL.
    const marked = prior.watermark === "present" ? prior : candidate.watermark === "present" ? candidate : undefined;
    const clean = prior.watermark === "none" ? prior : candidate.watermark === "none" ? candidate : undefined;
    const stronger = pixels(candidate) > pixels(prior) || pixels(candidate) === pixels(prior) && bitrate(candidate) > bitrate(prior) ? candidate : prior;
    unique.set(candidate.url, { ...stronger, bitrate: Math.max(bitrate(prior), bitrate(candidate)) || undefined, rendition: prior.rendition === "original" || candidate.rendition === "original" ? "original" : stronger.rendition, watermark: marked ? "present" : clean ? "none" : "unknown", evidence: (marked || clean || stronger).evidence, resourceId: prior.resourceId && candidate.resourceId && prior.resourceId !== candidate.resourceId ? undefined : prior.resourceId || candidate.resourceId });
  }
  return [...unique.values()].sort((a, b) => watermarkOrder[a.watermark] - watermarkOrder[b.watermark]
    || Number(b.rendition === "original") - Number(a.rendition === "original")
    || pixels(b) - pixels(a) || bitrate(b) - bitrate(a)).slice(0, 256);
}
