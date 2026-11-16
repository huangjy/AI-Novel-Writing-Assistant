const GATED_ROUTE_PREFIXES = [
  "/novels/auto-director",
  "/creative-hub",
  "/book-analysis",
  "/style-engine",
  "/worlds/generator",
];

interface AutomaticSetupPromptInput {
  pathname?: string;
  statusResolved: boolean;
  readyForCreation: boolean;
  dismissed: boolean;
  modelSettingsOpen?: boolean;
}

interface RouteSetupPromptInput {
  statusResolved: boolean;
  readyForCreation: boolean;
  pathname: string;
  modelSettingsOpen?: boolean;
}

interface FirstNovelHandoffInput {
  configurationSucceeded: boolean;
  forceConfiguration: boolean;
}

interface ProviderSelectionInitializationInput {
  open: boolean;
  statusAvailable: boolean;
  providerKind: "builtin" | "custom";
  provider: string;
}

export function shouldOpenAutomaticSetupPrompt(input: AutomaticSetupPromptInput): boolean {
  return input.statusResolved && !input.readyForCreation && !input.dismissed && !input.modelSettingsOpen
    && input.pathname !== "/settings/authorization";
}

export function shouldOpenSetupPromptForRoute(input: RouteSetupPromptInput): boolean {
  return input.statusResolved
    && !input.readyForCreation
    && !input.modelSettingsOpen
    && GATED_ROUTE_PREFIXES.some((prefix) => input.pathname.startsWith(prefix));
}

export function shouldShowFirstNovelHandoff(input: FirstNovelHandoffInput): boolean {
  return input.configurationSucceeded && !input.forceConfiguration;
}

export function shouldInitializeProviderSelection(
  input: ProviderSelectionInitializationInput,
): boolean {
  return input.open
    && input.statusAvailable
    && input.providerKind === "builtin"
    && !input.provider;
}
