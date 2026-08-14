// Onboarding wizard open/close state (#464).
//
// A tiny slice of its own rather than a prop threaded through BoardPage → Layout: the wizard is
// opened from three unrelated places (after a register, after a create, and from the command
// palette) and rendered in a fourth. Prop-drilling an opener through all of them is exactly the
// band of props #895/B was breaking up — see boardSelectionStore.ts for the same reasoning.
//
// Deliberately holds ONLY "is it open, and for which project". The plan itself is server state:
// the wizard fetches it and re-renders from whatever each apply/skip call returns, so there is
// no second copy here to drift from the board's own derivation (#463).
import { create } from "zustand";

export interface OnboardingState {
  /** Project the wizard is open for. `null` = closed. */
  projectId: string | null;
  /** Name shown in the header — passed in because the wizard does not fetch the project. */
  projectName: string | null;
  /**
   * True when the wizard was opened automatically right after a register/create, as opposed to
   * reopened deliberately. The wizard uses it for its intro line only: a freshly imported project
   * needs "here is what is left to do", a revisit does not.
   */
  justImported: boolean;

  openOnboarding: (projectId: string, projectName: string, opts?: { justImported?: boolean }) => void;
  closeOnboarding: () => void;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  projectId: null,
  projectName: null,
  justImported: false,

  openOnboarding: (projectId, projectName, opts) =>
    set({ projectId, projectName, justImported: opts?.justImported === true }),
  closeOnboarding: () => set({ projectId: null, projectName: null, justImported: false }),
}));

/** Imperative actions for non-component callers (the project-management hook). */
export const onboardingActions = {
  openOnboarding: (projectId: string, projectName: string, opts?: { justImported?: boolean }) =>
    useOnboardingStore.getState().openOnboarding(projectId, projectName, opts),
  closeOnboarding: () => useOnboardingStore.getState().closeOnboarding(),
};
