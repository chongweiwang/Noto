import { Facet } from "@codemirror/state";
import { desktop } from "../../lib/desktop-api";
import type { VaultApi } from "../../lib/vault-api";

export const notePathFacet = Facet.define<string, string>({ combine: (values) => values[0] || "" });
export const assetApiFacet = Facet.define<Pick<VaultApi, "image">, Pick<VaultApi, "image">>({ combine: (values) => values[0] ?? desktop });
