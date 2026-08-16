import { useRef, useState } from "react";
import { useDismissable } from "./useDismissable.js";

export interface Tag {
  id: string;
  name: string;
  color: string | null;
}

/**
 * Encapsulates the TableView bulk-action UI state: row selection, the six
 * dropdown open/closed booleans (plus their outside-click-to-close listener),
 * the bulk due-date input, and the lazily loaded tag list.
 */
export function useBulkOperations() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  const [bulkPriorityOpen, setBulkPriorityOpen] = useState(false);
  const [bulkEstimateOpen, setBulkEstimateOpen] = useState(false);
  const [bulkDueDateOpen, setBulkDueDateOpen] = useState(false);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkRemoveTagOpen, setBulkRemoveTagOpen] = useState(false);
  const [bulkDueDate, setBulkDueDate] = useState("");
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagsLoaded, setTagsLoaded] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);
  const priorityDropdownRef = useRef<HTMLDivElement>(null);
  const estimateDropdownRef = useRef<HTMLDivElement>(null);
  const dueDateDropdownRef = useRef<HTMLDivElement>(null);
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  const removeTagDropdownRef = useRef<HTMLDivElement>(null);

  // Six independent dropdowns, one hook call each (#515). The single shared listener
  // this replaces re-tested all six on every mousedown anywhere in the document and
  // handled no Escape at all — so none of these six was keyboard-dismissable.
  useDismissable(statusDropdownRef, bulkStatusOpen, () => setBulkStatusOpen(false));
  useDismissable(priorityDropdownRef, bulkPriorityOpen, () => setBulkPriorityOpen(false));
  useDismissable(estimateDropdownRef, bulkEstimateOpen, () => setBulkEstimateOpen(false));
  useDismissable(dueDateDropdownRef, bulkDueDateOpen, () => setBulkDueDateOpen(false));
  useDismissable(tagDropdownRef, bulkTagOpen, () => setBulkTagOpen(false));
  useDismissable(removeTagDropdownRef, bulkRemoveTagOpen, () => setBulkRemoveTagOpen(false));

  return {
    selectedIds, setSelectedIds,
    bulkLoading, setBulkLoading,
    bulkStatusOpen, setBulkStatusOpen,
    bulkPriorityOpen, setBulkPriorityOpen,
    bulkEstimateOpen, setBulkEstimateOpen,
    bulkDueDateOpen, setBulkDueDateOpen,
    bulkTagOpen, setBulkTagOpen,
    bulkRemoveTagOpen, setBulkRemoveTagOpen,
    bulkDueDate, setBulkDueDate,
    allTags, setAllTags,
    tagsLoaded, setTagsLoaded,
    statusDropdownRef,
    priorityDropdownRef,
    estimateDropdownRef,
    dueDateDropdownRef,
    tagDropdownRef,
    removeTagDropdownRef,
  };
}
