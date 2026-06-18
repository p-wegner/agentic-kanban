import { useCallback, useEffect, useState } from "react";
import { getSettings, setSettings } from "../lib/settingsStore.js";

export interface IssueTemplate {
  id: string;
  name: string;
  body: string;
}

const MAX_TEMPLATES = 20;

const BUILTIN_TEMPLATES: IssueTemplate[] = [
  {
    id: "builtin-bug",
    name: "Bug report",
    body: `## Problem

<!-- What is broken? -->

## Steps to reproduce

1.
2.
3.

## Expected behavior

<!-- What should happen? -->

## Actual behavior

<!-- What happens instead? -->

## Environment

<!-- Version, OS, browser, etc. -->`,
  },
  {
    id: "builtin-feature",
    name: "Feature request",
    body: `## Goal

<!-- What should the feature do? -->

## Acceptance criteria

- [ ]
- [ ]
- [ ]

## Context / motivation

<!-- Why is this needed? -->`,
  },
];

function parseTemplates(raw: string | undefined): IssueTemplate[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as IssueTemplate[];
  } catch {}
  return [];
}

export function allTemplates(custom: IssueTemplate[]): IssueTemplate[] {
  return [...BUILTIN_TEMPLATES, ...custom];
}

export function useIssueTemplates() {
  const [customTemplates, setCustomTemplates] = useState<IssueTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSettings()
      .then((s) => setCustomTemplates(parseTemplates(s.issue_templates)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback(async (templates: IssueTemplate[]) => {
    await setSettings({ issue_templates: JSON.stringify(templates) });
    setCustomTemplates(templates);
  }, []);

  const add = useCallback(async (template: Omit<IssueTemplate, "id">) => {
    const next = [...customTemplates, { ...template, id: `custom-${Date.now()}` }];
    if (next.length > MAX_TEMPLATES) throw new Error(`Maximum ${MAX_TEMPLATES} custom templates`);
    await save(next);
  }, [customTemplates, save]);

  const update = useCallback(async (id: string, patch: Partial<Omit<IssueTemplate, "id">>) => {
    const next = customTemplates.map((t) => t.id === id ? { ...t, ...patch } : t);
    await save(next);
  }, [customTemplates, save]);

  const remove = useCallback(async (id: string) => {
    await save(customTemplates.filter((t) => t.id !== id));
  }, [customTemplates, save]);

  return {
    loading,
    customTemplates,
    templates: allTemplates(customTemplates),
    MAX_TEMPLATES,
    add,
    update,
    remove,
  };
}
