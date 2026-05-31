import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { layoutGraph } from "../lib/workflowLayout.js";

const NODE_TYPES = ["start", "normal", "parallel-fork", "parallel-join", "end"] as const;
const EDGE_CONDITIONS = ["manual", "auto_on_exit_0", "tests_pass", "tests_fail", "diff_clean", "diff_touches"] as const;

const NODE_COLORS: Record<string, string> = {
  start: "#dcfce7",
  normal: "#eff6ff",
  "parallel-fork": "#f3e8ff",
  "parallel-join": "#f3e8ff",
  end: "#e5e7eb",
};

interface Skill { id: string; name: string }
interface StatusOpt { id: string; name: string }

type NodeData = {
  label: string;
  nodeType: string;
  statusName: string | null;
  skillId: string | null;
  skillName: string | null;
  maxVisits: number;
  config: string | null;
};

let tmpCounter = 0;
const tmpId = () => `tmp-${Date.now()}-${tmpCounter++}`;

export function WorkflowBuilder({
  projectId,
  templateId,
  onClose,
  onSaved,
}: {
  projectId: string;
  templateId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState("New Workflow");
  const [description, setDescription] = useState("");
  const [ticketType, setTicketType] = useState<string>("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [statuses, setStatuses] = useState<StatusOpt[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [isBuiltin, setIsBuiltin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const rfRef = useRef<ReactFlowInstance<Node<NodeData>, Edge> | null>(null);

  // Zoom-to-fit after node positions change (layout / load). react-flow needs a
  // beat to apply the new positions and measure node sizes before fitView can
  // compute the right bounds — for large graphs a single RAF fits stale bounds
  // (clipping the top/bottom), so fit after a short delay and once more after
  // the animation to guarantee the whole graph is in view.
  const fitSoon = useCallback(() => {
    const fit = () => rfRef.current?.fitView({ padding: 0.2, duration: 300 });
    setTimeout(fit, 150);
    setTimeout(fit, 500);
  }, []);

  useEffect(() => {
    apiFetch<Skill[]>(`/api/agent-skills?projectId=${projectId}`).then(setSkills).catch(() => {});
    apiFetch<StatusOpt[]>(`/api/projects/${projectId}/statuses`).then(setStatuses).catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (!templateId) return;
    apiFetch<any>(`/api/workflows/templates/${templateId}`).then((t) => {
      setName(t.name);
      setDescription(t.description ?? "");
      setTicketType(t.ticketType ?? "");
      setIsBuiltin(!!t.isBuiltin);
      const rawNodes = (t.nodes as any[]).map((n) => ({
        id: n.id,
        position: { x: n.posX ?? 0, y: n.posY ?? 0 },
        data: {
          label: n.name,
          nodeType: n.nodeType,
          statusName: n.statusName,
          skillId: n.skillId,
          skillName: n.skillName,
          maxVisits: n.maxVisits ?? 0,
          config: n.config,
        },
        style: nodeStyle(n.nodeType),
      }));
      const rawEdges = (t.edges as any[]).map((e) => ({
        id: e.id,
        source: e.fromNodeId,
        target: e.toNodeId,
        label: edgeLabel(e.label, e.condition),
        data: { label: e.label, condition: e.condition, isLoop: !!e.isLoop },
      }));
      // Always lay out hierarchically on open. Stored coordinates today are
      // unreliable (built-ins use x=0; agent-created templates rarely supply
      // sensible coordinates), so a deterministic top-to-bottom dagre layout is
      // the human-friendly default. Saving persists these positions.
      if (rawNodes.length > 1) {
        const pos = layoutGraph(rawNodes, rawEdges);
        for (const n of rawNodes) {
          const p = pos.get(n.id);
          if (p) n.position = p;
        }
      }
      setNodes(rawNodes);
      setEdges(rawEdges);
      // Always zoom-to-fit on open (the initial `fitView` prop fits the empty
      // graph because nodes load async, so it never refits the loaded graph).
      fitSoon();
    }).catch(() => showToast("Failed to load workflow", "error"));
  }, [templateId, setNodes, setEdges, fitSoon]);

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((eds) => addEdge({ ...c, id: tmpId(), label: "manual", data: { label: null, condition: "manual", isLoop: false } }, eds)),
    [setEdges],
  );

  function addNode(type: string) {
    const id = tmpId();
    setNodes((nds) => [
      ...nds,
      {
        id,
        position: { x: 80 + Math.random() * 120, y: 60 + nds.length * 30 },
        data: { label: cap(type), nodeType: type, statusName: defaultStatus(type), skillId: null, skillName: null, maxVisits: 0, config: null },
        style: nodeStyle(type),
      },
    ]);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  }

  function patchNode(id: string, patch: Partial<NodeData>) {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, ...patch }, style: nodeStyle(patch.nodeType ?? n.data.nodeType), }
          : n,
      ),
    );
  }
  function patchEdge(id: string, patch: { label?: string | null; condition?: string; isLoop?: boolean }) {
    setEdges((eds) =>
      eds.map((e) =>
        e.id === id
          ? { ...e, data: { ...(e.data ?? {}), ...patch }, label: edgeLabel(patch.label ?? (e.data as any)?.label, patch.condition ?? (e.data as any)?.condition) }
          : e,
      ),
    );
  }
  function autoLayout() {
    setNodes((nds) => {
      const pos = layoutGraph(
        nds.map((n) => ({ id: n.id })),
        edges.map((e) => ({ source: e.source, target: e.target })),
      );
      return nds.map((n) => (pos.get(n.id) ? { ...n, position: pos.get(n.id)! } : n));
    });
    fitSoon();
  }

  function deleteSelected() {
    if (selectedNodeId) {
      setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
      setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
      setSelectedNodeId(null);
    } else if (selectedEdgeId) {
      setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
  }

  async function save() {
    setSaving(true);
    setErrors([]);
    const payload = {
      projectId,
      name,
      description: description || null,
      ticketType: ticketType || null,
      nodes: nodes.map((n, i) => ({
        id: n.id,
        name: n.data.label,
        nodeType: n.data.nodeType,
        statusName: n.data.statusName,
        skillId: n.data.skillId,
        skillName: n.data.skillName,
        maxVisits: n.data.maxVisits,
        config: n.data.config,
        posX: n.position.x,
        posY: n.position.y,
        sortOrder: i,
      })),
      edges: edges.map((e, i) => ({
        fromNodeId: e.source,
        toNodeId: e.target,
        label: (e.data as any)?.label ?? null,
        condition: (e.data as any)?.condition ?? "manual",
        isLoop: !!(e.data as any)?.isLoop,
        sortOrder: i,
      })),
    };
    try {
      if (templateId && !isBuiltin) {
        await apiFetch(`/api/workflows/templates/${templateId}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        // New template, or "save" of a builtin → create a fresh editable copy.
        await apiFetch(`/api/workflows/templates`, { method: "POST", body: JSON.stringify(payload) });
      }
      showToast("Workflow saved", "success");
      onSaved();
      onClose();
    } catch (err: any) {
      const data = err?.body ?? err?.data;
      if (data?.errors) setErrors(data.errors);
      showToast(err instanceof Error ? err.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedNodeId), [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find((e) => e.id === selectedEdgeId), [edges, selectedEdgeId]);

  return (
    <div className="fixed inset-0 z-50 bg-white dark:bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="text-sm font-semibold bg-transparent border border-gray-300 dark:border-gray-600 rounded px-2 py-1 dark:text-gray-100"
        />
        <select value={ticketType} onChange={(e) => setTicketType(e.target.value)} className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 dark:bg-gray-900 dark:text-gray-100" title="Default for ticket type">
          <option value="">No auto-route</option>
          <option value="task">task</option>
          <option value="bug">bug</option>
          <option value="feature">feature</option>
          <option value="chore">chore</option>
        </select>
        {isBuiltin && <span className="text-[11px] text-amber-600">built-in → saving creates an editable copy</span>}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={autoLayout} className="text-xs border border-gray-300 dark:border-gray-600 px-3 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-800 dark:text-gray-200" title="Arrange nodes top-to-bottom">
            Auto layout
          </button>
          <button onClick={save} disabled={saving} className="text-xs bg-brand-600 text-white px-3 py-1.5 rounded hover:bg-brand-700 disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={onClose} className="text-xs text-gray-500 dark:text-gray-400 px-3 py-1.5 hover:text-gray-700">Close</button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs px-4 py-2 border-b border-red-200 dark:border-red-800">
          {errors.map((e, i) => <div key={i}>• {e}</div>)}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Palette */}
        <div className="w-40 border-r border-gray-200 dark:border-gray-700 p-2 space-y-1">
          <div className="text-[11px] uppercase text-gray-400 mb-1">Add node</div>
          {NODE_TYPES.map((t) => (
            <button key={t} onClick={() => addNode(t)} className="w-full text-left text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800" style={{ borderLeft: `4px solid ${NODE_COLORS[t]}` }}>
              + {cap(t)}
            </button>
          ))}
          <div className="text-[11px] text-gray-400 pt-2">Drag from a node's handle to connect. Click a node/edge to edit.</div>
        </div>

        {/* Canvas */}
        <div className="flex-1 min-w-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => { setSelectedNodeId(n.id); setSelectedEdgeId(null); }}
            onEdgeClick={(_, e) => { setSelectedEdgeId(e.id); setSelectedNodeId(null); }}
            onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
            onInit={(inst) => { rfRef.current = inst; }}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        {/* Side panel */}
        <div className="w-64 border-l border-gray-200 dark:border-gray-700 p-3 overflow-y-auto text-sm dark:text-gray-200">
          {selectedNode ? (
            <div className="space-y-2">
              <div className="font-semibold text-xs uppercase text-gray-400">Node</div>
              <label className="block text-xs">Name
                <input value={selectedNode.data.label} onChange={(e) => patchNode(selectedNode.id, { label: e.target.value })} className="w-full mt-0.5 border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600" />
              </label>
              <label className="block text-xs">Type
                <select value={selectedNode.data.nodeType} onChange={(e) => patchNode(selectedNode.id, { nodeType: e.target.value })} className="w-full mt-0.5 border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600">
                  {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="block text-xs">Board status
                <select value={selectedNode.data.statusName ?? ""} onChange={(e) => patchNode(selectedNode.id, { statusName: e.target.value || null })} className="w-full mt-0.5 border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600">
                  <option value="">(none)</option>
                  {statuses.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
              </label>
              <label className="block text-xs">Skill
                <select value={selectedNode.data.skillId ?? ""} onChange={(e) => { const s = skills.find((x) => x.id === e.target.value); patchNode(selectedNode.id, { skillId: e.target.value || null, skillName: s?.name ?? null }); }} className="w-full mt-0.5 border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600">
                  <option value="">(none)</option>
                  {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="block text-xs">Max visits (0 = unlimited)
                <input type="number" min={0} value={selectedNode.data.maxVisits} onChange={(e) => patchNode(selectedNode.id, { maxVisits: Number(e.target.value) || 0 })} className="w-full mt-0.5 border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600" />
              </label>
              <label className="block text-xs">Guidance
                <textarea
                  rows={3}
                  value={readGuidance(selectedNode.data.config)}
                  onChange={(e) => patchNode(selectedNode.id, { config: writeGuidance(selectedNode.data.config, e.target.value) })}
                  placeholder="Extra instructions injected into agent prompts at this node…"
                  className="w-full mt-0.5 border rounded px-2 py-1 text-xs dark:bg-gray-800 dark:border-gray-600"
                />
              </label>
              {selectedNode.data.nodeType === "parallel-fork" && (
                <label className="block text-xs">Fork mode
                  <select value={readForkMode(selectedNode.data.config)} onChange={(e) => patchNode(selectedNode.id, { config: writeForkMode(selectedNode.data.config, e.target.value) })} className="w-full mt-0.5 border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600">
                    <option value="worktree">Worktree — each branch its own worktree (parallel)</option>
                    <option value="shared">Shared — one worktree/branch (sequential)</option>
                  </select>
                  <span className="block text-[10px] text-gray-400 mt-0.5">Shared runs stages one at a time on the same branch (each commits before the next starts) — independent agents can't safely share a git index concurrently.</span>
                </label>
              )}
              {selectedNode.data.nodeType === "parallel-join" && (
                <label className="block text-xs">Join strategy
                  <select value={readJoinStrategy(selectedNode.data.config)} onChange={(e) => patchNode(selectedNode.id, { config: writeJoinStrategy(selectedNode.data.config, e.target.value) })} className="w-full mt-0.5 border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600">
                    <option value="artifacts">Artifacts — agent merges branches by hand</option>
                    <option value="merge">Auto-merge child branches into this branch</option>
                  </select>
                  <span className="block text-[10px] text-gray-400 mt-0.5">Auto-merge suits additive work (each child writes a different file). Conflicting merges are auto-aborted and left for the agent.</span>
                </label>
              )}
              <button onClick={deleteSelected} className="text-xs text-red-600 hover:text-red-700">Delete node</button>
            </div>
          ) : selectedEdge ? (
            <div className="space-y-2">
              <div className="font-semibold text-xs uppercase text-gray-400">Edge</div>
              <label className="block text-xs">Label
                <input value={(selectedEdge.data as any)?.label ?? ""} onChange={(e) => patchEdge(selectedEdge.id, { label: e.target.value || null })} className="w-full mt-0.5 border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600" />
              </label>
              <label className="block text-xs">Condition
                <select
                  value={edgeConditionBase((selectedEdge.data as any)?.condition ?? "manual")}
                  onChange={(e) => {
                    const currentCondition = (selectedEdge.data as any)?.condition ?? "manual";
                    const nextCondition = e.target.value === "diff_touches"
                      ? writeDiffTouchesCondition(readDiffTouchesGlob(currentCondition))
                      : e.target.value;
                    patchEdge(selectedEdge.id, { condition: nextCondition });
                  }}
                  className="w-full mt-0.5 border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600"
                >
                  {EDGE_CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              {edgeConditionBase((selectedEdge.data as any)?.condition ?? "manual") === "diff_touches" && (
                <label className="block text-xs">Glob
                  <input
                    value={readDiffTouchesGlob((selectedEdge.data as any)?.condition ?? "")}
                    onChange={(e) => patchEdge(selectedEdge.id, { condition: writeDiffTouchesCondition(e.target.value) })}
                    placeholder="packages/server/**"
                    className="w-full mt-0.5 border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600"
                  />
                </label>
              )}
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!!(selectedEdge.data as any)?.isLoop}
                  onChange={(e) => patchEdge(selectedEdge.id, { isLoop: e.target.checked })}
                />
                Intentional loop edge
              </label>
              <button onClick={deleteSelected} className="text-xs text-red-600 hover:text-red-700">Delete edge</button>
            </div>
          ) : (
            <div className="text-xs text-gray-400">Select a node or edge to edit its properties, or add a node from the palette.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Read the join strategy from a node's JSON config (defaults to "artifacts"). */
function readJoinStrategy(config: string | null): string {
  if (!config) return "artifacts";
  try { return (JSON.parse(config) as { joinStrategy?: string }).joinStrategy === "merge" ? "merge" : "artifacts"; }
  catch { return "artifacts"; }
}
/** Write the join strategy into a node's JSON config, preserving other keys. */
function writeJoinStrategy(config: string | null, strategy: string): string | null {
  let obj: Record<string, unknown> = {};
  if (config) { try { obj = JSON.parse(config) as Record<string, unknown>; } catch { obj = {}; } }
  if (strategy === "merge") obj.joinStrategy = "merge"; else delete obj.joinStrategy;
  return Object.keys(obj).length ? JSON.stringify(obj) : null;
}

/** Read the guidance string from a node's JSON config (defaults to ""). */
function readGuidance(config: string | null): string {
  if (!config) return "";
  try { return (JSON.parse(config) as { guidance?: string }).guidance ?? ""; }
  catch { return ""; }
}
/** Write the guidance string into a node's JSON config, preserving other keys. */
function writeGuidance(config: string | null, value: string): string | null {
  let obj: Record<string, unknown> = {};
  if (config) { try { obj = JSON.parse(config) as Record<string, unknown>; } catch { obj = {}; } }
  if (value) obj.guidance = value; else delete obj.guidance;
  return Object.keys(obj).length ? JSON.stringify(obj) : null;
}

/** Read the fork mode from a node's JSON config (defaults to "worktree"). */
function readForkMode(config: string | null): string {
  if (!config) return "worktree";
  try { return (JSON.parse(config) as { forkMode?: string }).forkMode === "shared" ? "shared" : "worktree"; }
  catch { return "worktree"; }
}
/** Write the fork mode into a node's JSON config, preserving other keys. */
function writeForkMode(config: string | null, mode: string): string | null {
  let obj: Record<string, unknown> = {};
  if (config) { try { obj = JSON.parse(config) as Record<string, unknown>; } catch { obj = {}; } }
  if (mode === "shared") obj.forkMode = "shared"; else delete obj.forkMode;
  return Object.keys(obj).length ? JSON.stringify(obj) : null;
}

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " "); }
function edgeConditionBase(condition: string): string {
  const idx = condition.indexOf(":");
  return idx === -1 ? condition : condition.slice(0, idx);
}
function readDiffTouchesGlob(condition: string): string {
  return edgeConditionBase(condition) === "diff_touches" ? condition.slice("diff_touches:".length) : "";
}
function writeDiffTouchesCondition(glob: string): string {
  return `diff_touches:${glob}`;
}
function defaultStatus(type: string): string | null {
  if (type === "start") return "In Progress";
  if (type === "end") return "Done";
  if (type === "normal") return "In Progress";
  return "In Review";
}
function edgeLabel(label: string | null | undefined, condition: string | null | undefined): string {
  const parts = [label, condition && condition !== "manual" ? `[${condition}]` : ""].filter(Boolean);
  return parts.join(" ") || "manual";
}
function nodeStyle(type: string) {
  return {
    background: NODE_COLORS[type] ?? "#fff",
    border: "1px solid #94a3b8",
    borderRadius: 8,
    fontSize: 12,
    padding: 6,
    color: "#111",
  };
}
