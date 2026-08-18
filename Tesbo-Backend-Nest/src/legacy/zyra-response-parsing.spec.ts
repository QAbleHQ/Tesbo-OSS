import { LegacyService } from "./legacy.service";
import type { DatabaseService } from "../database/database.service";
import type { EmailService } from "../auth/email.service";
import type { PasswordService } from "../auth/password.service";
import type { AppConfigService } from "../config/app-config.service";
import type { StorageService } from "../storage/storage.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import type { RagRetrievalService } from "../rag/rag-retrieval.service";
import type { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import type { ApiTokenService } from "../auth/api-token.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function makeLegacy(): LegacyService {
  return new LegacyService(
    { query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    {} as unknown as CustomFieldsService
  );
}

// The parsing helpers are private implementation detail — reached here directly because the
// whole point of these tests is the text-in/text-out contract, with no provider round trip.
type Internals = {
  parseModelJson: (raw: string, salvageFields?: string[]) => Record<string, unknown> | null;
  sanitizeZyraReply: (raw: unknown, fallback: string) => string;
  reconcileZyraReply: (
    decision: { reply: string; actionType: string; operations: { type: string }[] },
    applied: { testcases: unknown[]; activity: { title?: string; detail?: string }[] }
  ) => string;
};

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

describe("Zyra model-response parsing", () => {
  let svc: LegacyService;

  beforeEach(() => {
    svc = makeLegacy();
  });

  describe("parseModelJson", () => {
    it("parses a well-formed envelope unchanged", () => {
      const raw = JSON.stringify({ reply: "## Fine\n\nA \"quoted\" phrase.", action: "answer" });
      expect(internals(svc).parseModelJson(raw)).toMatchObject({
        reply: '## Fine\n\nA "quoted" phrase.',
        action: "answer"
      });
    });

    it("recovers an envelope with unescaped quotes inside reply", () => {
      // The exact break seen in production: the model wrote "remember me" without escaping.
      const raw = '{"reply":"## Gaps\\n\\n- Does a session survive a restart if a "remember me" option exists?","reasoningSummary":"Coverage analysis.","action":"answer","actionType":"answer","operations":[],"testcases":[]}';
      expect(() => JSON.parse(raw)).toThrow(); // strict parse cannot handle it
      const parsed = internals(svc).parseModelJson(raw);
      expect(parsed?.reply).toContain('"remember me"');
      expect(parsed?.reasoningSummary).toBe("Coverage analysis.");
    });

    it("recovers an envelope with literal newlines inside reply", () => {
      const raw = '{"reply":"## Coverage\n\nAll 10 cases live in one suite.\n\n### Gaps\n- Password reset","action":"answer"}';
      expect(() => JSON.parse(raw)).toThrow();
      expect(internals(svc).parseModelJson(raw)?.reply).toContain("Password reset");
    });

    it("recovers an envelope broken by newlines and unescaped quotes together", () => {
      const raw = '{"reply":"## Gaps\n\n- A "remember me" flow\n- Reset link expiry","reasoningSummary":"note","operations":[],"testcases":[]}';
      const parsed = internals(svc).parseModelJson(raw);
      expect(parsed?.reply).toContain('"remember me"');
      expect(parsed?.reply).toContain("Reset link expiry");
    });

    it("unwraps a markdown-fenced envelope", () => {
      const raw = '```json\n{"reply":"## Hello\\n\\nWorld","action":"answer"}\n```';
      expect(internals(svc).parseModelJson(raw)?.reply).toBe("## Hello\n\nWorld");
    });

    it("salvages the reply text when the envelope is unrecoverably malformed", () => {
      // Truncated mid-array: neither strict nor repaired parse can succeed.
      const raw = '{"reply":"## Partial answer with a "quote" inside","operations":[{"type":"create",';
      expect(internals(svc).parseModelJson(raw)?.reply).toContain("Partial answer");
    });

    it("returns null for prose so callers can surface it as a plain answer", () => {
      expect(internals(svc).parseModelJson("Here is a plain answer with no JSON.")).toBeNull();
      expect(internals(svc).parseModelJson("")).toBeNull();
    });
  });

  describe("sanitizeZyraReply", () => {
    it("passes markdown prose straight through", () => {
      expect(internals(svc).sanitizeZyraReply("## Coverage\n\n- One", "fb")).toBe("## Coverage\n\n- One");
    });

    it("unwraps a nested well-formed envelope", () => {
      const nested = JSON.stringify({ reply: "## Real answer", action: "answer" });
      expect(internals(svc).sanitizeZyraReply(nested, "fb")).toBe("## Real answer");
    });

    it("unwraps a nested malformed envelope instead of showing raw JSON", () => {
      const nested = '{"reply":"## Real answer with a "quote"","action":"answer","operations":[],"testcases":[]}';
      const out = internals(svc).sanitizeZyraReply(nested, "fb");
      expect(out).toContain("## Real answer");
      expect(out).not.toContain('"action"');
      expect(out).not.toContain('"operations"');
    });

    it("falls back rather than leaking an envelope with no usable reply", () => {
      const nested = '{"action":"answer","actionType":"answer","operations":[],"testcases":[]}';
      const out = internals(svc).sanitizeZyraReply(nested, "Fallback answer.");
      expect(out).toBe("Fallback answer.");
    });

    it("never returns text that still looks like a JSON envelope", () => {
      const blobs = [
        '{"reply":"ok","action":"answer"}',
        '{"reply":"ok with "quotes"","action":"answer"}',
        '{"action":"answer","operations":[]}',
        '{"reply":"trailing truncation","operations":[{"type":'
      ];
      for (const blob of blobs) {
        const out = internals(svc).sanitizeZyraReply(blob, "Fallback answer.");
        expect(out.trim().startsWith("{")).toBe(false);
        expect(out).not.toContain('"actionType"');
      }
    });
  });
  /*
   * Basecamp 10212827246 ("AI Test Case Creation Shows Success but Test Cases Are Not Reflected") and
   * the "Created 20 edge case test scenarios..." / "7 test cases generated" mismatch on 10212918496.
   *
   * decision.reply is model prose describing what the model INTENDED. applyZyraChatOperations is what
   * writes, and it drops operations for the per-message cap, external-id conflicts, missing test cases
   * or suites, and capability gating. reconcileZyraReply used to correct only the all-or-nothing case,
   * so a partial application returned the model's larger number verbatim.
   *
   * Driven directly rather than through the API for the reason the whole file exists: this is a
   * text-in/text-out contract, and the e2e suite deliberately never calls a model.
   */
  describe("reconcileZyraReply", () => {
    const creates = (n: number) => Array.from({ length: n }, () => ({ type: "create" }));
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `tc-${i}` }));

    it("passes the reply through when every requested operation was applied", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 3 test cases.", actionType: "create", operations: creates(3) },
        { testcases: rows(3), activity: [] }
      );
      expect(out).toBe("Created 3 test cases.");
    });

    it("flags a partial application instead of repeating the model's larger number", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 20 edge case test scenarios.", actionType: "create", operations: creates(20) },
        { testcases: rows(7), activity: [] }
      );
      expect(out).toContain("7 of 20");
      // The model's own prose is kept below the correction rather than discarded.
      expect(out).toContain("Created 20 edge case test scenarios.");
    });

    it("names the reason a partial application dropped operations", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 30 test cases.", actionType: "create", operations: creates(30) },
        {
          testcases: rows(25),
          activity: [
            { title: "Skipped some operations", detail: "5 operation(s) beyond the 25-per-message limit were not applied." },
            { title: "Created testcase", detail: "AIP-TC-1 Login" }
          ]
        }
      );
      expect(out).toContain("25 of 30");
      expect(out).toContain("25-per-message limit");
      // An ordinary success entry is not a failure reason and must not be quoted as one.
      expect(out).not.toContain("AIP-TC-1 Login");
    });

    it("still reports the all-or-nothing case as nothing saved", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 5 test cases.", actionType: "create", operations: creates(5) },
        { testcases: [], activity: [] }
      );
      expect(out).toContain("Nothing was saved");
    });

    it("treats a suite-only turn as a complete success", () => {
      // create_suite touches no test case, so it must not read as a partial application.
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created the Smoke Tests suite.", actionType: "create_suite", operations: [{ type: "create_suite" }] },
        { testcases: [], activity: [] }
      );
      expect(out).toBe("Created the Smoke Tests suite.");
    });

    it("leaves a plain answer alone", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "There are 12 login test cases.", actionType: "answer", operations: [] },
        { testcases: [], activity: [] }
      );
      expect(out).toBe("There are 12 login test cases.");
    });
  });
});
