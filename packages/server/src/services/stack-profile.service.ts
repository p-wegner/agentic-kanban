// Facade for the stack-profile sub-services (arch-review #911).
//
// The single-file god-module (763 lines, 28 top-level fns) was split by responsibility
// into ./stack-profile/{persistence,smart-hooks-rules,test-scaffold,verify-script,
// smoke-check,setup-script}.ts behind this facade — see agent-stream-parser.ts /
// workflow-engine.ts / git-service.ts for the same pattern. The PUBLIC export surface is
// kept byte-identical so the ~21 consumers' imports of "./stack-profile.service.js" don't
// change.
//
// `detectStackProfile` itself lives in stack-detector.service (#853); it is re-exported
// here too so its importers keep importing it from stack-profile.service unchanged.

export { detectStackProfile } from "./stack-detector.service.js";

// --- Profile lifecycle: detect → enrich (LLM) → persist / read ---
export type { StackProfileScaffoldOptions } from "./stack-profile/persistence.js";
export {
  stackProfilePrefKey,
  isProfileSparse,
  populateStackProfile,
  saveStackProfile,
  saveManualStackProfile,
  getStackProfile,
} from "./stack-profile/persistence.js";

// --- Edit-time feedback rules (#787) ---
export type { SmartHooksRule, SmartHooksRulesFile } from "./stack-profile/smart-hooks-rules.js";
export {
  buildSmartHooksRules,
  smartHooksRulesPath,
  writeSmartHooksRules,
} from "./stack-profile/smart-hooks-rules.js";

// --- Stack-aware test scaffold (#793) ---
export type { TestScaffold } from "./stack-profile/test-scaffold.js";
export { deriveTestScaffold, writeTestScaffold } from "./stack-profile/test-scaffold.js";

// --- Verify (merge-gate) command (#788) ---
export {
  verifyScriptPrefKey,
  deriveVerifyScriptFromProfile,
  populateVerifyScript,
} from "./stack-profile/verify-script.js";

// --- Run/smoke verification harness (#791) ---
export { buildSmokeCheck } from "./stack-profile/smoke-check.js";

// --- Setup (install) script (#810) ---
export { deriveSetupScriptFromProfile, populateSetupScript } from "./stack-profile/setup-script.js";
