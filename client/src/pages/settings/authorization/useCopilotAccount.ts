import { useQuery, type QueryClient } from "@tanstack/react-query";
import { getCopilotAccount } from "@/api/authorization";
import { queryKeys } from "@/api/queryKeys";

export function useCopilotAccount(enabled = true) {
  return useQuery({
    queryKey: queryKeys.settings.copilotAccount, queryFn: getCopilotAccount, enabled,
    retry: false, refetchOnWindowFocus: true,
    refetchInterval: query => query.state.data?.data?.activeSession?.state === "pending"
      ? Math.max(1000, query.state.data.data.activeSession.pollIntervalMs) : false,
  });
}

export async function refreshAuthorizationProjections(client: QueryClient) {
  await Promise.all([
    queryKeys.settings.copilotAccount, queryKeys.settings.apiKeys, queryKeys.llm.providers,
    queryKeys.settings.quickSetup, queryKeys.onboarding.firstNovel, queryKeys.settings.llmSelection,
  ].map(queryKey => client.invalidateQueries({ queryKey })));
}
