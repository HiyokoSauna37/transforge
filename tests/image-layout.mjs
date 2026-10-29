import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../content/image-layout.js", import.meta.url), "utf8");
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
class Element {
  constructor(bounds, position = "static", parentElement = null) {
    this.bounds = bounds;
    this.position = position;
    this.parentElement = parentElement;
    this.root = document;
  }
  getBoundingClientRect() { return this.bounds; }
  getRootNode() { return this.root; }
}
const document = { documentElement: {}, elementsFromPoint: () => [] };
const context = vm.createContext({ document, HTMLElement: Element, getComputedStyle: node => node, innerWidth: 1000, innerHeight: 700 });
vm.runInContext(code, context);
const layout = context.TFImageLayout;
const plain = value => JSON.parse(JSON.stringify(value));

const image = Object.assign(new Element(rect(100, 50, 480, 230)), {
  offsetWidth: 240, offsetHeight: 230, clientWidth: 236, clientHeight: 226, clientLeft: 2, clientTop: 2,
});
assert.deepEqual(plain(layout.contentRect(image, { paddingLeft: "10px", paddingRight: "20px", paddingTop: "5px", paddingBottom: "15px" })),
  rect(124, 57, 412, 206));
const unscaled = Object.assign(new Element(rect(12, 18, 1, 1)), {
  offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0, clientLeft: 0, clientTop: 0,
});
assert.deepEqual(plain(layout.contentRect(unscaled, {})), rect(12, 18, 1, 1));
console.log("✓ image content bounds exclude padding and borders, preserve viewport position and account for scaling");

const fit = (objectFit, objectPosition, w = 400, h = 100) => plain(layout.fittedRect(200, 200, w, h, { objectFit, objectPosition }));
assert.deepEqual(fit("fill"), { left: 0, top: 0, width: 200, height: 200 });
assert.deepEqual(fit("contain"), { left: 0, top: 75, width: 200, height: 50 });
assert.deepEqual(fit("cover"), { left: -300, top: 0, width: 800, height: 200 });
assert.deepEqual(fit("none"), { left: -100, top: 50, width: 400, height: 100 });
assert.deepEqual(fit("scale-down"), fit("contain"));
assert.deepEqual(fit("scale-down", undefined, 80, 40), { left: 60, top: 80, width: 80, height: 40 });
assert.deepEqual(fit("contain", "left top"), { left: 0, top: 0, width: 200, height: 50 });
assert.deepEqual(fit("contain", "right bottom"), { left: 0, top: 150, width: 200, height: 50 });
assert.deepEqual(fit("cover", "25% 75%"), { left: -150, top: 0, width: 800, height: 200 });
assert.deepEqual(fit("none", "12px 16px"), { left: 12, top: 16, width: 400, height: 100 });
console.log("✓ translated image fitting preserves contain/cover/none/scale-down and percentage, keyword or pixel positioning");

const source = new Element(rect(100, 50, 400, 300));
const host = new Element(rect(0, 0, 1000, 700), "fixed");
host.shadowRoot = {};
const header = new Element(rect(0, 0, 1000, 90), "fixed");
const headerLabel = new Element(rect(120, 65, 70, 20), "static", header);
const footer = new Element(rect(0, 330, 1000, 370), "sticky");
const sidebar = new Element(rect(0, 0, 130, 700), "fixed");
const rightbar = new Element(rect(480, 0, 520, 700), "fixed");
const positioned = new Element(source.bounds, "relative");
const noInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let stack = [];
document.elementsFromPoint = () => stack;
const insets = () => plain(layout.occlusionInsets(source.bounds, source, host));
stack = [source, header];
assert.deepEqual(insets(), noInsets, "layers behind the image must not clip it");
stack = [positioned, source];
assert.deepEqual(insets(), noInsets, "ordinary positioned content is not a fixed occluder");
stack = [headerLabel, header, source];
assert.deepEqual(insets(), { ...noInsets, top: 40 }, "nested header content resolves to its fixed layer");
stack = [header, footer, sidebar, rightbar, source];
assert.deepEqual(insets(), { top: 40, right: 20, bottom: 20, left: 30 });
const overlayChild = new Element(source.bounds, "fixed");
overlayChild.root = host.shadowRoot;
stack = [overlayChild, host, source];
assert.deepEqual(insets(), noInsets, "the extension must not treat its own overlay as an occluder");
stack = [headerLabel];
assert.deepEqual(insets(), { ...noInsets, top: 40 }, "the frontmost fixed layer still clips when the source is absent from hit testing");
document.elementsFromPoint = () => { throw new Error("empty rectangles must not hit-test"); };
assert.deepEqual(plain(layout.occlusionInsets(rect(0, 0, 0, 0), source, host)), noInsets);
vm.runInContext(code, context);
assert.equal(context.TFImageLayout, layout, "reinjection preserves the initialized module");
console.log("✓ clipping follows frontmost fixed/sticky layers on every edge while ignoring ordinary content and the extension overlay");
