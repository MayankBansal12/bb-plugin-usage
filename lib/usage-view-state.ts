export type UsageMachineState = {
  id: string;
  name: string;
  status?: string;
};

export type UsageSourceState = {
  machineId: string;
  status: string;
};

export type EmptyUsageView = {
  kind: "offline" | "error" | "filtered" | "no-data" | "initial";
  title: string;
  description: string;
};

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function offlineMachines(machines: UsageMachineState[], sources: UsageSourceState[]) {
  const sourceOfflineIds = new Set(sources.filter((source) => source.status === "offline").map((source) => source.machineId));
  return machines.filter((machine) => (machine.status && machine.status !== "connected") || sourceOfflineIds.has(machine.id));
}

export function getSourceIssueMessage(machines: UsageMachineState[], sources: UsageSourceState[]) {
  const offline = offlineMachines(machines, sources);
  const failedScans = sources.filter((source) => ["partial", "unavailable"].includes(source.status)).length;
  if (offline.length === 0 && failedScans === 0) return null;

  const details: string[] = [];
  if (offline.length === 1) details.push(`${offline[0]!.name} is offline`);
  else if (offline.length > 1) details.push(`${plural(offline.length, "machine")} are offline`);
  if (failedScans > 0) details.push(`${plural(failedScans, "agent scan")} failed or ${failedScans === 1 ? "was" : "were"} incomplete`);

  return `${details.join("; ")}. Available records are included.`;
}

export function getEmptyUsageView({
  machines,
  sources,
  hasRecordsOutsideView,
}: {
  machines: UsageMachineState[];
  sources: UsageSourceState[];
  hasRecordsOutsideView: boolean;
}): EmptyUsageView {
  const offline = offlineMachines(machines, sources);
  const allMachinesOffline = machines.length > 0 && offline.length === machines.length;
  const failedScans = sources.filter((source) => ["partial", "unavailable"].includes(source.status));

  if (allMachinesOffline) {
    const oneMachine = machines.length === 1 ? machines[0] : null;
    return {
      kind: "offline",
      title: oneMachine ? `${oneMachine.name} is offline` : "Machines are offline",
      description: oneMachine
        ? "Reconnect this machine, then sync usage to check its local history."
        : "Reconnect a machine, then sync usage to check its local history.",
    };
  }

  if (failedScans.length > 0) {
    return {
      kind: "error",
      title: failedScans.some((source) => source.status === "partial") ? "Usage scan was incomplete" : "Usage couldn’t be collected",
      description: `${plural(failedScans.length, "agent scan")} failed or returned incomplete data. Try syncing again.`,
    };
  }

  if (hasRecordsOutsideView) {
    return {
      kind: "filtered",
      title: "No usage in this date range",
      description: offline.length > 0
        ? `Try a wider date range or choose another machine. ${plural(offline.length, "machine")} ${offline.length === 1 ? "is" : "are"} currently offline.`
        : "Try a wider date range or choose another machine.",
    };
  }

  const connectedMachines = Math.max(0, machines.length - offline.length);
  if (sources.some((source) => source.status === "no-data") || connectedMachines > 0) {
    const offlineSuffix = offline.length > 0
      ? ` ${plural(offline.length, "machine")} could not be checked because ${offline.length === 1 ? "it is" : "they are"} offline.`
      : "";
    return {
      kind: "no-data",
      title: "No usage found",
      description: `Connected machines were checked, but no supported usage logs were found.${offlineSuffix}`,
    };
  }

  return {
    kind: "initial",
    title: "No usage data yet",
    description: "Sync a connected machine to check for local usage history.",
  };
}
