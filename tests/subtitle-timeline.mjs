import assert from "node:assert/strict";
import "../content/subtitle-timeline.js";
import { normalizeSubtitles } from "../shared/subtitles.js";

const T = globalThis.TFSubtitleTimeline;
const cues = T.normalize([{ start: 4, end: 6, text: "Second" }, { start: 0, end: 2, text: "First" }, { start: 4, end: 6, text: "Second" }]);
assert.deepEqual(cues.map((c) => c.id), [0, 1]);
assert.equal(T.indexAt(cues, 0), 0);
assert.equal(T.indexAt(cues, 1.99), 0);
assert.equal(T.indexAt(cues, 2), -1);
assert.equal(T.indexAt(cues, 3), -1);
assert.equal(T.indexAt(cues, 4), 1);
assert.equal(T.indexAt(cues, 6), -1);
assert.equal(T.indexAt([], 0), -1);
const overlap = T.normalize([{ start: 0, end: 9, text: "earlier" }, { start: 4, end: 7, text: "later" }]);
assert.equal(overlap[0].end, 4);
assert.equal(T.indexAt(overlap, 5), 1);
const many = T.normalize(Array.from({ length: 100 }, (_, i) => ({ start: i * 4, end: i * 4 + 3, text: `cue ${i}` })));
const groups = T.batches(many);
assert.ok(groups.every((b) => b.length <= 12));
assert.equal(T.nextBatch(groups, 100, new Map()), 2);
const done = new Map(groups[2].map((c) => [c.id, "translated"]));
assert.equal(T.nextBatch(groups, 100, done), -1); // 次バッチは144秒、40秒先の範囲外
assert.equal(T.nextBatch(groups, 110, done), 3);
assert.equal(T.nextBatch(groups, 0, done), 0); // 巻き戻し先を優先
const long = T.normalize(Array.from({ length: 20 }, (_, i) => ({ start: i, end: i + 1, text: "字".repeat(2000) })));
for (const batch of T.batches(long)) {
  normalizeSubtitles({ videoId: "abcdefghijk", cues: batch, context: { title: "test", ...T.context(long, batch[0].id, batch.at(-1).id) } });
}
assert.throws(() => T.normalize([{ start: 0, end: 1, text: "x".repeat(2001) }]), /長さ/);
console.log("✓ subtitle timing: exact boundaries, gaps, overlap, bounded lookahead, backward seeking and long-cue context");
