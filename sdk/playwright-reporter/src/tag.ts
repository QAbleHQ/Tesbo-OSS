/**
 * Extracting the Tesbo case id from a Playwright test.
 *
 * Basecamp 10189985971 §3 standardises the marker as `tesbo.testId("<CASE_ID>")` across every
 * language SDK, and shows it for Playwright as:
 *
 *     test('user can reset password', { tag: 'tesbo.testId("TES-1042")' }, async ({ page }) => {});
 *
 * **That form does not work.** Playwright validates tags against `^@` and throws
 * `Tag must start with "@" symbol, got "tesbo.testId("TES-1042")" instead.` at collection time
 * (playwright/lib/common/index.js). A suite written to the card verbatim fails to load; it does not
 * silently not report.
 *
 * So the accepted Playwright form carries one leading `@`:
 *
 *     test('user can reset password', { tag: '@tesbo.testId("TES-1042")' }, async ({ page }) => {});
 *
 * This is not a divergence from the card's goal — it lands on it. The card's own pytest and JUnit
 * examples are already `@tesbo.testId("TES-1042")` (a decorator and an annotation, both `@`-
 * prefixed); only the Playwright example dropped the `@`. With it, the marker is character-for-
 * character identical in all three languages, which is what §3 asked for: "a developer moving from
 * a JS repo to a Java repo recognizes it instantly."
 *
 * The `test.info().annotations` form is also accepted, for suites that prefer annotations or that
 * compute the id at runtime:
 *
 *     test('...', { annotation: { type: 'tesbo', description: 'TES-1042' } }, async () => {});
 */

/**
 * Matches `@tesbo.testId("TES-1042")` and its reasonable spellings: single or double quotes, and
 * incidental whitespace inside the parentheses. Anchored so `@not-tesbo.testId(...)` does not match.
 *
 * The id itself is `[^"')\s]+` rather than a shape like `[A-Z]+-\d+`: a project's external ids are
 * whatever its team chose, and validating the *shape* here would reject valid ids offline. The
 * server is the authority on whether an id exists, which is what the resolve call at startup is for.
 */
const TAG_PATTERN = /^@tesbo\.testId\(\s*['"]([^"')\s]+)['"]\s*\)$/;

/** The annotation type that carries a case id, for the `{ annotation: … }` form. */
const ANNOTATION_TYPE = "tesbo";

export interface TaggedTest {
  caseId: string | null;
  /**
   * Set when a marker was present but unusable — a `@tesbo.testId` tag whose contents could not be
   * parsed. Distinct from `caseId: null` with no reason, which just means "untagged".
   *
   * The difference matters: an untagged test is a normal, expected state for a suite mid-adoption,
   * while a malformed marker is a typo the author intended to work and should be told about.
   */
  malformed: string | null;
}

/**
 * Reads the case id out of a test's tags and annotations.
 *
 * Tags win over annotations when both are present, because the tag is the documented convention and
 * an annotation is the escape hatch. Multiple different ids on one test is treated as malformed
 * rather than by silently picking one: a test that claims to validate two cases would otherwise
 * report against whichever the iteration order happened to reach first.
 */
export function extractCaseId(tags: readonly string[], annotations: readonly { type: string; description?: string }[]): TaggedTest {
  const found = new Set<string>();
  let sawMarker = false;

  for (const tag of tags) {
    if (!tag.startsWith("@tesbo.")) continue;
    sawMarker = true;
    const match = TAG_PATTERN.exec(tag.trim());
    if (match) found.add(match[1]);
  }

  if (!found.size) {
    for (const annotation of annotations) {
      if (annotation.type !== ANNOTATION_TYPE) continue;
      sawMarker = true;
      const value = (annotation.description ?? "").trim();
      if (value) found.add(value);
    }
  }

  if (found.size === 1) return { caseId: [...found][0], malformed: null };
  if (found.size > 1) {
    return {
      caseId: null,
      malformed: `declares more than one Tesbo case id (${[...found].sort().join(", ")}); a test may map to exactly one case`
    };
  }
  if (sawMarker) {
    return {
      caseId: null,
      malformed: `has a Tesbo marker that could not be read; expected tag: '@tesbo.testId("TES-1042")'`
    };
  }
  return { caseId: null, malformed: null };
}

/** The tag string for a case id, so docs and tests have one source for the format. */
export function tesboTag(caseId: string): string {
  return `@tesbo.testId("${caseId}")`;
}
