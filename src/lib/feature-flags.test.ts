import { describe, expect, it } from "vitest";

import {
  autoConfirmProfileProposalsEnabled,
  autoConfirmRoutineProposalsEnabled,
  autoConfirmSkillProposalsEnabled,
  builtInBrowserEnabled,
  sharedComputersEnabled,
  showToolCallsEnabled,
  skillAuthoringEnabled,
} from "./feature-flags";

describe("experimental feature flags", () => {
  it("keeps skill authoring on by default, before and after the config arrives", () => {
    expect(skillAuthoringEnabled(null)).toBe(true);
    expect(skillAuthoringEnabled({})).toBe(true);
    expect(skillAuthoringEnabled({ features: {} })).toBe(true);
    expect(skillAuthoringEnabled({ features: { skillAuthoring: true } })).toBe(true);
  });

  it("switches skill authoring off only on an explicit opt-out", () => {
    expect(skillAuthoringEnabled({ features: { skillAuthoring: false } })).toBe(false);
  });

  it("keeps the experimental browser off until explicitly enabled", () => {
    expect(builtInBrowserEnabled(null)).toBe(false);
    expect(builtInBrowserEnabled({})).toBe(false);
    expect(builtInBrowserEnabled({ features: { browser: false } })).toBe(false);
    expect(builtInBrowserEnabled({ features: { browser: true } })).toBe(true);
  });

  it("hides tool-call chips by default", () => {
    expect(showToolCallsEnabled(null)).toBe(false);
    expect(showToolCallsEnabled({})).toBe(false);
    expect(showToolCallsEnabled({ features: { showToolCalls: false } })).toBe(false);
  });

  it("shows tool-call chips only after explicit opt-in", () => {
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it("keeps routine auto-confirm off until explicitly enabled", () => {
    expect(autoConfirmRoutineProposalsEnabled(null)).toBe(false);
    expect(autoConfirmRoutineProposalsEnabled({})).toBe(false);
    expect(autoConfirmRoutineProposalsEnabled({ features: { autoConfirmRoutineProposals: false } })).toBe(false);
    expect(autoConfirmRoutineProposalsEnabled({ features: { autoConfirmRoutineProposals: true } })).toBe(true);
  });

  it("keeps profile auto-confirm off until explicitly enabled", () => {
    expect(autoConfirmProfileProposalsEnabled(null)).toBe(false);
    expect(autoConfirmProfileProposalsEnabled({})).toBe(false);
    expect(autoConfirmProfileProposalsEnabled({ features: { autoConfirmProfileProposals: false } })).toBe(false);
    expect(autoConfirmProfileProposalsEnabled({ features: { autoConfirmProfileProposals: true } })).toBe(true);
  });

  it("keeps skill auto-confirm off until explicitly enabled", () => {
    expect(autoConfirmSkillProposalsEnabled(null)).toBe(false);
    expect(autoConfirmSkillProposalsEnabled({})).toBe(false);
    expect(autoConfirmSkillProposalsEnabled({ features: { autoConfirmSkillProposals: false } })).toBe(false);
    expect(autoConfirmSkillProposalsEnabled({ features: { autoConfirmSkillProposals: true } })).toBe(true);
  });

  it("keeps computer sharing off unless the server says it is on", () => {
    expect(sharedComputersEnabled(null)).toBe(false);
    expect(sharedComputersEnabled({})).toBe(false);
    expect(sharedComputersEnabled({ features: {} })).toBe(false);
    expect(sharedComputersEnabled({ features: { sharedComputers: false } })).toBe(false);
    expect(sharedComputersEnabled({ features: { sharedComputers: true } })).toBe(true);
  });
});
