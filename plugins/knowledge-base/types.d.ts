/** The managed overlay row's config when the instance has a platform address (network mode). */
export interface KnowledgeBaseConfig {
  /** `http://<instance bridge +3 IPv4>:<platform port>`, without a path. */
  readonly platformUrl: string;
}
