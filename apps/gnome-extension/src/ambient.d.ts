declare module 'gi://*' {
  const value: any;
  export default value;
}

declare module 'resource://*' {
  const value: any;
  export = value;
}

declare module 'resource:///org/gnome/shell/extensions/extension.js' {
  export class Extension {
    dir: any;
    constructor(...args: any[]);
    enable(): void;
    disable(): void;
  }
}

declare const console: {
  log: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug: (...args: any[]) => void;
};