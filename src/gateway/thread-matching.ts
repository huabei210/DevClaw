import { TargetRef, ThreadSummary } from "../shared/types";

export interface ResolvedThreadMatch extends ThreadSummary {
  deviceId: string;
}

function pickPreferredMatch(matches: ResolvedThreadMatch[], currentTarget?: TargetRef): ResolvedThreadMatch | undefined {
  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1 && currentTarget) {
    const preferred = matches.find(
      (item) =>
        item.workspaceId === currentTarget.workspaceId &&
        item.assistantKind === currentTarget.assistantKind
    );
    if (preferred) {
      return preferred;
    }
  }

  return matches.length > 0 ? matches[0] : undefined;
}

export function matchThreadByQuery(
  threadIdQuery: string,
  candidates: ResolvedThreadMatch[],
  currentTarget?: TargetRef
): ResolvedThreadMatch | undefined {
  const normalizedQuery = threadIdQuery.trim().toLowerCase();
  if (!normalizedQuery) {
    return undefined;
  }

  const exactMatches: ResolvedThreadMatch[] = [];
  const prefixMatches: ResolvedThreadMatch[] = [];

  for (const candidate of candidates) {
    const threadId = candidate.threadId.toLowerCase();
    if (threadId === normalizedQuery) {
      exactMatches.push(candidate);
      continue;
    }

    if (threadId.startsWith(normalizedQuery)) {
      prefixMatches.push(candidate);
    }
  }

  const exactMatch = pickPreferredMatch(exactMatches, currentTarget);
  if (exactMatch) {
    return exactMatch;
  }

  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }

  if (prefixMatches.length > 1 && currentTarget) {
    return prefixMatches.find(
      (item) =>
        item.workspaceId === currentTarget.workspaceId &&
        item.assistantKind === currentTarget.assistantKind
    );
  }

  return undefined;
}
