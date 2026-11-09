export function configure(source: string, target: string | undefined, releases: string, options?: Record<string, unknown>, sourceRoot?: string): string
export function findHost(candidates: string[], run?: (command: string, args: string[], options: { encoding: "utf8"; timeout: number }) => string): { command: string; version: string }
export function verifySnapshot(directory: string): Promise<{ files: Record<string, string> }>
export function install(args?: string[]): Promise<void>
