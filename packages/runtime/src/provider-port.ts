import type { ProviderEvent, ProviderInvocation, ProviderModelMetadata } from "@endec/domain";

export interface ProviderPort {
  invoke(input: ProviderInvocation): AsyncIterable<ProviderEvent>;
  describeModel?(input: Pick<ProviderModelMetadata, "providerId" | "modelId">): Promise<ProviderModelMetadata | null>;
}
