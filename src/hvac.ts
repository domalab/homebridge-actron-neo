import QueApi from './queApi';
import { PowerState, FanMode, ClimateMode, CompressorMode, validApiCommands, ZoneStatus, HvacStatus, CommandResult } from './types';
import { Logger } from 'homebridge';
import { HvacZone } from './hvacZone';

export class HvacUnit {
  readonly name: string;
  type = '';
  serialNo = '';
  apiInterface!: QueApi;

  cloudConnected = false;
  powerState: PowerState = PowerState.UNKNOWN;
  climateMode: ClimateMode = ClimateMode.UNKNOWN;
  fanMode: FanMode = FanMode.UNKNOWN;
  compressorMode: CompressorMode = CompressorMode.UNKNOWN;
  fanRunning = false;
  awayMode = false;
  quietMode = false;
  continuousFanMode = false;
  controlAllZones = false;
  masterCoolingSetTemp = 0;
  masterHeatingSetTemp = 0;
  masterCurrentTemp = 0;
  masterHumidity = 0;
  compressorChasingTemp = 0;
  compressorCurrentTemp = 0;
  zoneData: ZoneStatus[] = [];
  zoneInstances: HvacZone[] = [];

  constructor(name: string,
    private readonly log: Logger,
    private readonly hbUserStoragePath: string,
    readonly zonesFollowMaster = true,
    readonly zonesPushMaster = true,
    readonly zonesAsHeaterCoolers = false) {
    this.name = name;
  }

  async actronQueApi(username: string, password: string, serialNo = '') {
    this.type = 'actronNeo';
    this.apiInterface = new QueApi(username, password, this.name, this.log, this.hbUserStoragePath, serialNo);
    await this.apiInterface.initializer();
    if (this.apiInterface.actronSerial) {
      this.serialNo = this.apiInterface.actronSerial;
    } else {
      throw Error('Failed to locate device serial number. Please check your config file');
    }
    return this.serialNo;
  }

  /**
   * Retrieves the current status of the HVAC unit and updates internal state
   * @returns The current HVAC status
   */
  async getStatus(): Promise<HvacStatus> {
    try {
      const status = await this.apiInterface.getStatus();

      if (status.apiError) {
        this.log.warn('Failed to refresh status, Actron Neo Cloud unreachable or returned invalid data');
        return status;
      }

      // Update all properties with new values if they exist
      this.updateProperties(status);

      // Update zone instances
      this.updateZoneInstances();
      
      return status;
    } catch (error) {
      this.log.error(`Unexpected error in getStatus: ${error instanceof Error ? error.message : String(error)}`);
      return { apiError: true, zoneCurrentStatus: [] };
    }
  }

  /**
   * Updates the properties of the HVAC unit with the latest status
   * @param status The current HVAC status
   */
  private updateProperties(status: HvacStatus): void {
    // Helper function to update a property if the new value is defined
    const updateIfDefined = <T>(currentValue: T, newValue: T | undefined): T => {
      return (newValue === undefined) ? currentValue : newValue;
    };

    this.cloudConnected = updateIfDefined(this.cloudConnected, status.cloudConnected);
    this.powerState = updateIfDefined(this.powerState, status.powerState);
    this.climateMode = updateIfDefined(this.climateMode, status.climateMode);
    this.compressorMode = updateIfDefined(this.compressorMode, status.compressorMode);
    this.fanMode = updateIfDefined(this.fanMode, status.fanMode);
    this.fanRunning = updateIfDefined(this.fanRunning, status.fanRunning);
    this.masterCoolingSetTemp = updateIfDefined(this.masterCoolingSetTemp, status.masterCoolingSetTemp);
    this.masterHeatingSetTemp = updateIfDefined(this.masterHeatingSetTemp, status.masterHeatingSetTemp);
    this.compressorChasingTemp = updateIfDefined(this.compressorChasingTemp, status.compressorChasingTemp);
    this.compressorCurrentTemp = updateIfDefined(this.compressorCurrentTemp, status.compressorCurrentTemp);
    this.awayMode = updateIfDefined(this.awayMode, status.awayMode);
    this.quietMode = updateIfDefined(this.quietMode, status.quietMode);
    this.continuousFanMode = updateIfDefined(this.continuousFanMode, status.continuousFanMode);
    this.controlAllZones = updateIfDefined(this.controlAllZones, status.controlAllZones);
    this.masterCurrentTemp = updateIfDefined(this.masterCurrentTemp, status.masterCurrentTemp);
    this.masterHumidity = updateIfDefined(this.masterHumidity, status.masterCurrentHumidity);
    this.zoneData = updateIfDefined(this.zoneData, status.zoneCurrentStatus);
  }

  /**
   * Updates the zone instances with the latest zone data
   */
  private updateZoneInstances(): void {
    for (const zone of this.zoneData) {
      const targetInstance = this.zoneInstances.find(zoneInstance => zoneInstance.zoneName === zone.zoneName);
      if (targetInstance) {
        targetInstance.pushStatusUpdate(zone);
      } else {
        this.zoneInstances.push(new HvacZone(this.log, this.apiInterface, zone));
      }
    }
  }

  /**
   * Generic method to handle command execution and error handling
   * @param command The command to execute
   * @param successValue The value to set on success
   * @param propertyName The name of the property being updated (for logging)
   * @returns The result of the command execution
   */
  private async executeCommand<T>(command: validApiCommands, successValue: T, propertyName: string): Promise<T> {
    try {
      const response = await this.apiInterface.runCommand(command);
      
      if (response === CommandResult.SUCCESS) {
        return successValue;
      } else if (response === CommandResult.FAILURE) {
        await this.getStatus();
        this.log.error(`Failed to set ${propertyName} for ${this.name}, refreshing state from API`);
      } else {
        this.log.warn(`Failed to send ${propertyName} command, Actron Neo Cloud unreachable`);
      }
      
      return successValue;
    } catch (error) {
      this.log.error(`Error executing command ${command}: ${error instanceof Error ? error.message : String(error)}`);
      await this.getStatus();
      return successValue;
    }
  }

  /**
   * Turns the HVAC unit on
   * @returns The current power state
   */
  async setPowerStateOn(): Promise<PowerState> {
    if (this.powerState === PowerState.UNKNOWN) {
      await this.getStatus();
    }
    
    if (this.powerState === PowerState.ON) {
      return PowerState.ON;
    }
    
    const result = await this.executeCommand(validApiCommands.ON, PowerState.ON, 'power state');
    if (result === PowerState.ON) {
      this.powerState = PowerState.ON;
    }
    
    return this.powerState;
  }

  /**
   * Turns the HVAC unit off
   * @returns The current power state
   */
  async setPowerStateOff(): Promise<PowerState> {
    if (this.powerState === PowerState.UNKNOWN) {
      await this.getStatus();
    }
    
    if (this.powerState === PowerState.OFF) {
      return PowerState.OFF;
    }
    
    const result = await this.executeCommand(validApiCommands.OFF, PowerState.OFF, 'power state');
    if (result === PowerState.OFF) {
      this.powerState = PowerState.OFF;
    }
    
    return this.powerState;
  }

  /**
   * Sets the heating temperature
   * @param heatTemp The heating temperature setpoint
   * @returns The current heating temperature setpoint
   */
  async setHeatTemp(heatTemp: number): Promise<number> {
    try {
      const coolTemp = 0;
      const response = await this.apiInterface.runCommand(validApiCommands.HEAT_SET_POINT, coolTemp, heatTemp);
      
      if (response === CommandResult.SUCCESS) {
        this.masterHeatingSetTemp = heatTemp;
      } else if (response === CommandResult.FAILURE) {
        await this.getStatus();
        this.log.error(`Failed to set heating temperature for ${this.name}, refreshing state from API`);
      } else {
        this.log.warn('Failed to send heating temperature command, Actron Neo Cloud unreachable');
      }
      
      return this.masterHeatingSetTemp;
    } catch (error) {
      this.log.error(`Error setting heating temperature: ${error instanceof Error ? error.message : String(error)}`);
      await this.getStatus();
      return this.masterHeatingSetTemp;
    }
  }

  /**
   * Sets the cooling temperature
   * @param coolTemp The cooling temperature setpoint
   * @returns The current cooling temperature setpoint
   */
  async setCoolTemp(coolTemp: number): Promise<number> {
    try {
      const heatTemp = 0;
      const response = await this.apiInterface.runCommand(validApiCommands.COOL_SET_POINT, coolTemp, heatTemp);
      
      if (response === CommandResult.SUCCESS) {
        this.masterCoolingSetTemp = coolTemp;
      } else if (response === CommandResult.FAILURE) {
        await this.getStatus();
        this.log.error(`Failed to set cooling temperature for ${this.name}, refreshing state from API`);
      } else {
        this.log.warn('Failed to send cooling temperature command, Actron Neo Cloud unreachable');
      }
      
      return this.masterCoolingSetTemp;
    } catch (error) {
      this.log.error(`Error setting cooling temperature: ${error instanceof Error ? error.message : String(error)}`);
      await this.getStatus();
      return this.masterCoolingSetTemp;
    }
  }

  async setHeatCoolTemp(coolTemp: number, heatTemp: number): Promise<number[]> {
    const response = await this.apiInterface.runCommand(validApiCommands.HEAT_COOL_SET_POINT, coolTemp, heatTemp);
    if (response === CommandResult.SUCCESS) {
      this.masterCoolingSetTemp = coolTemp;
      this.masterHeatingSetTemp = heatTemp;
    } else if (response === CommandResult.FAILURE) {
      await this.getStatus();
      this.log.error(`Failed to set master ${this.name}, refreshing master state from API`);
    } else {
      this.log.warn('Failed to send command, Actron Neo Cloud unreachable');
    }
    return [this.masterCoolingSetTemp, this.masterHeatingSetTemp];
  }

  /**
   * Sets the climate mode to Auto
   * @returns The current climate mode
   */
  async setClimateModeAuto(): Promise<ClimateMode> {
    const result = await this.executeCommand(validApiCommands.CLIMATE_MODE_AUTO, ClimateMode.AUTO, 'climate mode');
    if (result === ClimateMode.AUTO) {
      this.climateMode = ClimateMode.AUTO;
    }
    return this.climateMode;
  }

  /**
   * Sets the climate mode to Cool
   * @returns The current climate mode
   */
  async setClimateModeCool(): Promise<ClimateMode> {
    const result = await this.executeCommand(validApiCommands.CLIMATE_MODE_COOL, ClimateMode.COOL, 'climate mode');
    if (result === ClimateMode.COOL) {
      this.climateMode = ClimateMode.COOL;
    }
    return this.climateMode;
  }

  /**
   * Sets the climate mode to Heat
   * @returns The current climate mode
   */
  async setClimateModeHeat(): Promise<ClimateMode> {
    const result = await this.executeCommand(validApiCommands.CLIMATE_MODE_HEAT, ClimateMode.HEAT, 'climate mode');
    if (result === ClimateMode.HEAT) {
      this.climateMode = ClimateMode.HEAT;
    }
    return this.climateMode;
  }

  async setClimateModeFan(): Promise<ClimateMode> {
    const response = await this.apiInterface.runCommand(validApiCommands.CLIMATE_MODE_FAN);
    if (response === CommandResult.SUCCESS) {
      this.climateMode = ClimateMode.FAN;
    } else if (response === CommandResult.FAILURE) {
      await this.getStatus();
      this.log.error(`Failed to set master ${this.name}, refreshing master state from API`);
    } else {
      this.log.warn('Failed to send command, Actron Neo Cloud unreachable');
    }
    return this.climateMode;
  }

  async setFanModeAuto(): Promise<FanMode> {
    const response = await this.apiInterface.runCommand(this.continuousFanMode ? validApiCommands.FAN_MODE_AUTO_CONT : validApiCommands.FAN_MODE_AUTO);
    if (response === CommandResult.SUCCESS) {
      this.fanMode = this.continuousFanMode ? FanMode.AUTO_CONT : FanMode.AUTO;
    } else if (response === CommandResult.FAILURE) {
      await this.getStatus();
      this.log.error(`Failed to set master ${this.name}, refreshing master state from API`);
    } else {
      this.log.warn('Failed to send command, Actron Neo Cloud unreachable');
    }
    return this.fanMode;
  }

  async setFanModeLow(): Promise<FanMode> {
    const response = await this.apiInterface.runCommand(this.continuousFanMode ? validApiCommands.FAN_MODE_LOW_CONT : validApiCommands.FAN_MODE_LOW);
    if (response === CommandResult.SUCCESS) {
      this.fanMode = this.continuousFanMode ? FanMode.LOW_CONT : FanMode.LOW;
    } else if (response === CommandResult.FAILURE) {
      await this.getStatus();
      this.log.error(`Failed to set master ${this.name}, refreshing master state from API`);
    } else {
      this.log.warn('Failed to send command, Actron Neo Cloud unreachable');
    }
    return this.fanMode;
  }

  async setFanModeMedium(): Promise<FanMode> {
    const response = await this.apiInterface.runCommand(this.continuousFanMode ? validApiCommands.FAN_MODE_MEDIUM_CONT : validApiCommands.FAN_MODE_MEDIUM);
    if (response === CommandResult.SUCCESS) {
      this.fanMode = this.continuousFanMode ? FanMode.MEDIUM_CONT : FanMode.MEDIUM;
    } else if (response === CommandResult.FAILURE) {
      await this.getStatus();
      this.log.error(`Failed to set master ${this.name}, refreshing master state from API`);
    } else {
      this.log.warn('Failed to send command, Actron Neo Cloud unreachable');
    }
    return this.fanMode;
  }

  async setFanModeHigh(): Promise<FanMode> {
    const response = await this.apiInterface.runCommand(this.continuousFanMode ? validApiCommands.FAN_MODE_HIGH_CONT : validApiCommands.FAN_MODE_HIGH);
    if (response === CommandResult.SUCCESS) {
      this.fanMode = this.continuousFanMode ? FanMode.HIGH_CONT : FanMode.HIGH;
    } else if (response === CommandResult.FAILURE) {
      await this.getStatus();
      this.log.error(`Failed to set master ${this.name}, refreshing master state from API`);
    } else {
      this.log.warn('Failed to send command, Actron Neo Cloud unreachable');
    }
    return this.fanMode;
  }

  /**
   * Turns on Away mode
   * @returns The current Away mode state
   */
  async setAwayModeOn(): Promise<boolean> {
    const result = await this.executeCommand(validApiCommands.AWAY_MODE_ON, true, 'away mode');
    if (result) {
      this.awayMode = true;
    }
    return this.awayMode;
  }

  /**
   * Turns off Away mode
   * @returns The current Away mode state
   */
  async setAwayModeOff(): Promise<boolean> {
    const result = await this.executeCommand(validApiCommands.AWAY_MODE_OFF, false, 'away mode');
    if (!result) {
      this.awayMode = false;
    }
    return this.awayMode;
  }

  /**
   * Turns on Quiet mode
   * @returns The current Quiet mode state
   */
  async setQuietModeOn(): Promise<boolean> {
    const result = await this.executeCommand(validApiCommands.QUIET_MODE_ON, true, 'quiet mode');
    if (result) {
      this.quietMode = true;
    }
    return this.quietMode;
  }

  /**
   * Turns off Quiet mode
   * @returns The current Quiet mode state
   */
  async setQuietModeOff(): Promise<boolean> {
    const result = await this.executeCommand(validApiCommands.QUIET_MODE_OFF, false, 'quiet mode');
    if (!result) {
      this.quietMode = false;
    }
    return this.quietMode;
  }

  async setContinuousFanModeOn(): Promise<boolean> {
    let response: CommandResult = CommandResult.FAILURE;
    if (this.fanMode === FanMode.AUTO || this.fanMode === FanMode.AUTO_CONT) {
      response = await this.apiInterface.runCommand(validApiCommands.FAN_MODE_AUTO_CONT);
    } else if (this.fanMode === FanMode.HIGH || this.fanMode === FanMode.HIGH_CONT) {
      response = await this.apiInterface.runCommand(validApiCommands.FAN_MODE_HIGH_CONT);
    } else if (this.fanMode === FanMode.MEDIUM || this.fanMode === FanMode.MEDIUM_CONT) {
      response = await this.apiInterface.runCommand(validApiCommands.FAN_MODE_MEDIUM_CONT);
    } else if (this.fanMode === FanMode.LOW || this.fanMode === FanMode.LOW_CONT) {
      response = await this.apiInterface.runCommand(validApiCommands.FAN_MODE_LOW_CONT);
    }
    if (response === CommandResult.SUCCESS) {
      this.continuousFanMode = true;
    } else if (response === CommandResult.FAILURE) {
      await this.getStatus();
      this.log.error(`Failed to set master ${this.name}, refreshing master state from API`);
      this.log.error(response);
    } else {
      this.log.warn('Failed to send command, Actron Neo Cloud unreachable');
    }
    return this.continuousFanMode;
  }

  async setContinuousFanModeOff(): Promise<boolean> {
    let response: CommandResult = CommandResult.FAILURE;
    if (this.fanMode === FanMode.AUTO || this.fanMode === FanMode.AUTO_CONT) {
      response = await this.apiInterface.runCommand(validApiCommands.FAN_MODE_AUTO);
    } else if (this.fanMode === FanMode.HIGH || this.fanMode === FanMode.HIGH_CONT) {
      response = await this.apiInterface.runCommand(validApiCommands.FAN_MODE_HIGH);
    } else if (this.fanMode === FanMode.MEDIUM || this.fanMode === FanMode.MEDIUM_CONT) {
      response = await this.apiInterface.runCommand(validApiCommands.FAN_MODE_MEDIUM);
    } else if (this.fanMode === FanMode.LOW || this.fanMode === FanMode.LOW_CONT) {
      response = await this.apiInterface.runCommand(validApiCommands.FAN_MODE_LOW);
    }
    if (response === CommandResult.SUCCESS) {
      this.continuousFanMode = false;
    } else if (response === CommandResult.FAILURE) {
      await this.getStatus();
      this.log.error(`Failed to set master ${this.name}, refreshing master state from API`);
    } else {
      this.log.warn('Failed to send command, Actron Neo Cloud unreachable');
    }
    return this.continuousFanMode;
  }
}