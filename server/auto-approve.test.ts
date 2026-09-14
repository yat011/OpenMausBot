// The harness's part in a provider's permission request: pass it through.
// These pin that nothing here judges an action, that Full access is the one
// synthesized answer, and that every note a card can show has a catalog key.
import { describe, expect, it } from "vitest";

import englishCatalog from "../src/locales/en.json" with { type: "json" };

import {
  HELD_NOTE,
  approvalHeldNote,
  approvalHeldReason,
  approvalModeForOrigin,
  autoVerdict,
  cliYoloFromEnv,
  effectiveApprovalMode,
} from "./auto-approve.ts";

describe("autoVerdict", () => {
  it("answers only for Full access, and then answers everything", () => {
    expect(autoVerdict("full", "Bash")).toEqual({ approve: "approved Bash (full access)", source: "full-access" });
    expect(autoVerdict("full", "Bash", { requiresExplicitApproval: true })).toEqual({
      approve: "approved Bash (full access)",
      source: "full-access",
    });
  });

  it("leaves an Auto or Custom request with the person as the provider's own reviewer did", () => {
    expect(autoVerdict("auto", "Bash")).toEqual({ approve: null, source: "native-approval" });
    expect(autoVerdict("custom", "Bash")).toEqual({ approve: null, source: "native-approval" });
  });

  it("never judges the action itself: Ask and Edits card everything the provider asks about", () => {
    for (const summary of ["wc -l notes.md", "rm -rf build", "cat ~/.ssh/id_rsa"]) {
      expect(autoVerdict("ask", summary)).toEqual({ approve: null, source: "no-grant" });
      expect(autoVerdict("edits", summary)).toEqual({ approve: null, source: "no-grant" });
    }
  });

  it("holds a sandbox widening for the person in every mode but Full", () => {
    for (const mode of ["ask", "edits", "auto", "custom"] as const) {
      expect(autoVerdict(mode, "shell", { requiresExplicitApproval: true }))
        .toEqual({ approve: null, source: "explicit-approval-block" });
    }
  });
});

describe("cliYoloFromEnv", () => {
  it("accepts 1/true/yes in either YOLO env var, and nothing else", () => {
    expect(cliYoloFromEnv({})).toBe(false);
    expect(cliYoloFromEnv({ OMB_YOLO: "1" })).toBe(true);
    expect(cliYoloFromEnv({ OMB_YOLO: "TRUE" })).toBe(true);
    expect(cliYoloFromEnv({ OMB_ALWAYS_APPROVE: "yes" })).toBe(true);
    expect(cliYoloFromEnv({ OMB_YOLO: "0" })).toBe(false);
    expect(cliYoloFromEnv({ OMB_YOLO: "ask" })).toBe(false);
  });
});

describe("effectiveApprovalMode", () => {
  it("keeps the stored level when YOLO is off", () => {
    expect(effectiveApprovalMode("auto", "grokAgent", { peerInitiated: false })).toBe("auto");
    expect(effectiveApprovalMode("ask", "grokAgent", { peerInitiated: false, yolo: false })).toBe("ask");
  });

  it("upgrades supported engines to Full when YOLO is on, including peer-started Custom", () => {
    expect(effectiveApprovalMode("auto", "grokAgent", { peerInitiated: false, yolo: true })).toBe("full");
    expect(effectiveApprovalMode("ask", "claudeAgent", { peerInitiated: false, yolo: true })).toBe("full");
    expect(effectiveApprovalMode("custom", "codex", { peerInitiated: true, yolo: true })).toBe("full");
  });

  it("does not invent Full for engines that have no mapping", () => {
    expect(effectiveApprovalMode("ask", "openai-compat", { peerInitiated: false, yolo: true })).toBe("ask");
  });

  it("still upgrades when the stored level is one the engine cannot run", () => {
    expect(effectiveApprovalMode("custom", "grokAgent", { peerInitiated: false, yolo: true })).toBe("full");
  });
});

describe("approvalModeForOrigin", () => {
  it("runs peer-started Custom turns as Auto and leaves every other mode alone", () => {
    expect(approvalModeForOrigin("custom", { peerInitiated: true })).toBe("auto");
    expect(approvalModeForOrigin("custom", { peerInitiated: false })).toBe("custom");
    for (const mode of ["ask", "edits", "auto", "full"] as const) {
      expect(approvalModeForOrigin(mode, { peerInitiated: true })).toBe(mode);
    }
  });
});

describe("held notes", () => {
  it("explains a provider's own request and a sandbox change, and nothing else", () => {
    expect(approvalHeldNote({ source: "native-approval", permission: true })).toBe("approval.held.native");
    expect(approvalHeldNote({ source: "explicit-approval-block", permission: true })).toBe("approval.held.sandbox");
    expect(approvalHeldNote({ source: "no-grant", permission: true })).toBeUndefined();
    expect(approvalHeldNote({ source: undefined, permission: true })).toBeUndefined();
    // questions are never held for a mode reason
    expect(approvalHeldNote({ source: "native-approval", permission: false })).toBeUndefined();
    expect(approvalHeldReason({ source: "native-approval", permission: true }))
      .toBe("The provider requires your approval for this action.");
  });

  it("has a catalog entry for every note, so the client can translate by key", () => {
    for (const [key, text] of Object.entries(HELD_NOTE)) {
      expect(englishCatalog[key as keyof typeof englishCatalog], key).toBe(text);
    }
  });
});
