export interface MonitorInfo {
  id: string;
  name: string;
  isExternal: boolean;
  bus?: number;
}

export interface BacklightState {
  connector: string;
  isHardware: boolean;
  value: number;
  min?: number;
  max?: number;
  bus?: number;
}

export interface IDisplayController {
  getHardwareBrightness(monitor: MonitorInfo): Promise<BacklightState | null>;
  setHardwareBrightness(monitor: MonitorInfo, state: BacklightState, value: number): Promise<void>;
}
