declare module "turndown" {
  export default class TurndownService {
    constructor(options?: Record<string, unknown>);
    turndown(input: string): string;
    addRule(name: string, rule: { filter: string | string[] | ((node: Element) => boolean); replacement: (content: string, node: Element) => string }): void;
  }
}
