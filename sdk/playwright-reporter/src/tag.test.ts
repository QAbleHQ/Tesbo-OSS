import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCaseId, tesboTag } from "./tag";

const noAnnotations: { type: string; description?: string }[] = [];

test("reads the case id from the documented tag form", () => {
  assert.deepEqual(extractCaseId(['@tesbo.testId("TES-1042")'], noAnnotations), {
    caseId: "TES-1042",
    malformed: null
  });
});

test("accepts single quotes and incidental whitespace", () => {
  assert.equal(extractCaseId([`@tesbo.testId( 'TES-7' )`], noAnnotations).caseId, "TES-7");
});

test("ignores unrelated tags alongside the marker", () => {
  assert.equal(extractCaseId(["@smoke", '@tesbo.testId("TES-1")', "@slow"], noAnnotations).caseId, "TES-1");
});

/*
 * The card's own Playwright example omits the leading '@'. Playwright itself refuses that tag
 * ("Tag must start with \"@\" symbol"), so a suite written to the card verbatim never loads — but if
 * the string ever reaches this parser (from an annotation, or a future framework), it must not be
 * silently accepted as valid, or the two forms would diverge.
 */
test("does not match the card's unprefixed form, which Playwright itself rejects", () => {
  assert.deepEqual(extractCaseId(['tesbo.testId("TES-1042")'], noAnnotations), {
    caseId: null,
    malformed: null
  });
});

test("a lookalike tag from another tool is not a Tesbo marker", () => {
  assert.deepEqual(extractCaseId(['@not-tesbo.testId("X-1")'], noAnnotations), {
    caseId: null,
    malformed: null
  });
});

test("untagged is untagged, not malformed", () => {
  assert.deepEqual(extractCaseId(["@smoke"], noAnnotations), { caseId: null, malformed: null });
  assert.deepEqual(extractCaseId([], noAnnotations), { caseId: null, malformed: null });
});

test("a Tesbo marker that cannot be parsed is reported as malformed", () => {
  const result = extractCaseId(["@tesbo.testId(TES-1042)"], noAnnotations);
  assert.equal(result.caseId, null);
  assert.match(result.malformed ?? "", /could not be read/);
});

test("an empty id is malformed rather than an empty case id", () => {
  const result = extractCaseId(['@tesbo.testId("")'], noAnnotations);
  assert.equal(result.caseId, null);
  assert.match(result.malformed ?? "", /could not be read/);
});

/*
 * Two ids on one test would otherwise report against whichever the iteration order reached first,
 * which is a silently wrong result attached to a real case — the failure mode §3 exists to prevent.
 */
test("more than one id on a test is refused, not arbitrarily resolved", () => {
  const result = extractCaseId(['@tesbo.testId("TES-1")', '@tesbo.testId("TES-2")'], noAnnotations);
  assert.equal(result.caseId, null);
  assert.match(result.malformed ?? "", /more than one Tesbo case id \(TES-1, TES-2\)/);
});

test("the same id declared twice is not a conflict", () => {
  assert.equal(extractCaseId(['@tesbo.testId("TES-1")', '@tesbo.testId("TES-1")'], noAnnotations).caseId, "TES-1");
});

test("falls back to the tesbo annotation when no tag carries an id", () => {
  assert.equal(extractCaseId([], [{ type: "tesbo", description: "TES-99" }]).caseId, "TES-99");
});

test("a tag wins over an annotation, since the tag is the documented convention", () => {
  assert.equal(
    extractCaseId(['@tesbo.testId("TES-TAG")'], [{ type: "tesbo", description: "TES-ANNOTATION" }]).caseId,
    "TES-TAG"
  );
});

test("annotations of other types are left alone", () => {
  assert.deepEqual(extractCaseId([], [{ type: "issue", description: "TES-1" }]), {
    caseId: null,
    malformed: null
  });
});

test("an empty tesbo annotation is malformed, not untagged", () => {
  const result = extractCaseId([], [{ type: "tesbo", description: "   " }]);
  assert.equal(result.caseId, null);
  assert.match(result.malformed ?? "", /could not be read/);
});

test("ids are not shape-validated locally — the project decides its own format", () => {
  // A team using 'LOGIN_01' or 'abc123' is not doing anything wrong; only the server knows which
  // ids exist, which is what the startup resolve call is for.
  assert.equal(extractCaseId(['@tesbo.testId("LOGIN_01")'], noAnnotations).caseId, "LOGIN_01");
  assert.equal(extractCaseId(['@tesbo.testId("abc123")'], noAnnotations).caseId, "abc123");
});

test("tesboTag round-trips through the parser", () => {
  assert.equal(extractCaseId([tesboTag("TES-500")], noAnnotations).caseId, "TES-500");
});
