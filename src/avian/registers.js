// BGT60TRxxC register words. Ported from lib_avian (BSD 3-Clause):
// ifxAvian_RegisterSet.cpp, Driver/data_acquisition.cpp,
// ifxAvian_Utilities.cpp (read_device_type, detect_device_type),
// Driver/registers_BGT60TRxxC.h, Driver/registers_BGT60TRxxE.h.

export const REG_MAIN = 0x00;
export const REG_CHIP_ID = 0x02;
export const REG_SFCTL = 0x06;
export const NUM_REGISTERS = 0x60;   // BGT60TRxxC_NUM_REGISTERS

export const MAIN_FRAME_START = 0x000001;
export const MAIN_FSM_RESET = 0x000004;
export const MAIN_FIFO_RESET = 0x000008;

export const SFCTL_MISO_HS_READ_pos = 16;
export const SFCTL_QSPI_WT_pos = 20;
export const SFCTL_QSPI_WT_msk = 0xF00000;

const WRITE_BIT = 0x01000000;

export const writeCommand = (address, value) => ((address << 25) | WRITE_BIT | (value & 0x00FFFFFF)) >>> 0;
export const readCommand = address => (address << 25) >>> 0;

// RegisterSet::get_configuration_sequence. Registers go out in ascending
// address order (std::map). With setTriggerBit, MAIN is held back and sent
// last with FRAME_START set, because it starts the frame.
export function configurationSequence(registers, setTriggerBit) {
  const addresses = [...registers.keys()].sort((a, b) => a - b);
  const sequence = [];
  let trigger = 0;
  for (const address of addresses) {
    const word = writeCommand(address, registers.get(address));
    if (address === REG_MAIN && setTriggerBit) { trigger = (word | MAIN_FRAME_START) >>> 0; continue; }
    sequence.push(word);
  }
  if (trigger) sequence.push(trigger);
  return sequence;
}

// Driver::reset(true): current MAIN value with FIFO_RESET and FSM_RESET set.
export const softResetCommand = mainValue => (writeCommand(REG_MAIN, mainValue) | MAIN_FIFO_RESET | MAIN_FSM_RESET) >>> 0;

// Driver::get_burst_prefix(); the readout address is its low byte.
export const burstPrefix = () => (0xFF000000 | (NUM_REGISTERS << 17) | NUM_REGISTERS) >>> 0;
export const readoutAddress = () => burstPrefix() & 0xFF;

// read_device_type, first step: SFCTL with MISO_HS_READ and QSPI_WT from the
// StrataControlPort properties { "Avian", high_speed_compensation false, quad_spi_wait_cycles 2 }.
export function sfctlCommand(highSpeedCompensation = false, quadSpiWaitCycles = 2) {
  const value = ((highSpeedCompensation ? 1 : 0) << SFCTL_MISO_HS_READ_pos)
              | (((quadSpiWaitCycles - 1) << SFCTL_QSPI_WT_pos) & SFCTL_QSPI_WT_msk);
  return writeCommand(REG_SFCTL, value);
}

// detect_device_type, BGT60TR13C branch only (the only device this app supports).
export function decodeChipId(word) {
  const rfId = word & 0xFF;
  const digitalId = (word >>> 8) & 0xFF;
  const stepId = (word >>> 16) & 0x3;
  const techId = (word >>> 18) & 0x3;
  return { rfId, digitalId, stepId, techId, isBGT60TR13C: digitalId === 3 && rfId === 3 };
}

// SFCTL FIFO_CREF: the FIFO fill level that raises the data interrupt.
export const SFCTL_FIFO_CREF_msk = 0x001FFF;

// Driver::set_slice_size -> program_registers_fifo: FIFO_CREF = slice / 2 - 1.
// The SDK sets the slice size when acquisition starts, after the register list
// was generated, so an exported register file carries the export-time value
// here. This is the only register field that depends on the slice size.
export function applySliceSize(registers, sliceSize) {
  const out = new Map(registers);
  const sfctl = out.get(REG_SFCTL) ?? 0;
  out.set(REG_SFCTL, (sfctl & ~SFCTL_FIFO_CREF_msk & 0xFFFFFF) | (((sliceSize / 2) - 1) & SFCTL_FIFO_CREF_msk));
  return out;
}

// Parses a register file as saved by the SDK's save_register_file()
// (Strata NamedMemory::saveConfig): one register per line,
// "NAME 0xAAAA 0xVVVVVVVV" (or "reg ..." for unnamed registers).
export function parseRegisterFile(text) {
  const registers = new Map();
  for (const line of text.split(/\r?\n/)) {
    const hexes = line.match(/0x[0-9a-fA-F]+/g);
    if (!hexes || hexes.length < 2) continue;
    const address = parseInt(hexes[hexes.length - 2], 16);
    const value = parseInt(hexes[hexes.length - 1], 16);
    registers.set(address, value & 0x00FFFFFF);
  }
  return registers;
}
