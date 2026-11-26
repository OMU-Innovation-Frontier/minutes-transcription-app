declare module 'cloudflare:node' {
  export function handleAsNodeRequest(port: number, request: Request): Promise<Response>;
}

declare module 'cloudflare:workers' {
  export class DurableObject<Env> {
    constructor(context: { waitUntil(work: Promise<unknown>): void }, env: Env);
    protected readonly ctx: { waitUntil(work: Promise<unknown>): void };
    protected readonly env: Env;
  }
}
