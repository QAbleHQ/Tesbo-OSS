import type { Request } from "express";

/** Identity/scope attached when a request authenticates via an API bearer token. */
export type ApiTokenContext = {
  tokenId: string;
  projectId: string | null;
  scopes: string[];
};

export type AuthenticatedRequest = Request & {
  userId?: string | null;
  /** Present only for requests authenticated with an API token (machine clients). */
  apiToken?: ApiTokenContext | null;
};
