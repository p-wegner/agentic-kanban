import { useEffect, useRef, useState } from "react";

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

  // Close dropdowns on outside click
  useEffect(() => {
    if (!bulkStatusOpen && !bulkPriorityOpen && !bulkEstimateOpen && !bulkDueDateOpen && !bulkTagOpen && !bulkRemoveTagOpen) return;
    function handle(e: MouseEvent) {
      if (bulkStatusOpen && statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setBulkStatusOpen(false);
      }
      if (bulkPriorityOpen && priorityDropdownRef.current && !priorityDropdownRef.current.contains(e.target as Node)) {
        setBulkPriorityOpen(false);
      }
      if (bulkEstimateOpen && estimateDropdownRef.current && !estimateDropdownRef.current.contains(e.target as Node)) {
        setBulkEstimateOpen(false);
      }
      if (bulkDueDateOpen && dueDateDropdownRef.current && !dueDateDropdownRef.current.contains(e.target as Node)) {
        setBulkDueDateOpen(false);
      }
      if (bulkTagOpen && tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setBulkTagOpen(false);
      }
      if (bulkRemoveTagOpen && removeTagDropdownRef.current && !removeTagDropdownRef.current.contains(e.target as Node)) {
        setBulkRemoveTagOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [bulkStatusOpen, bulkPriorityOpen, bulkEstimateOpen, bulkDueDateOpen, bulkTagOpen, bulkRemoveTagOpen]);

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
