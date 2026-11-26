import { getAttributeDefinition } from './attribute-definitions.js';
/** @import Capability from '../../lib/model/Capability.js' */
/** @import Entity from '../../lib/model/Entity.js' */
/** @import Fixture from '../../lib/model/Fixture.js' */
/** @import Wheel from '../../lib/model/Wheel.js' */

/**
 * @typedef {object} WheelInfo
 * @property {Wheel} wheel The OFL wheel.
 * @property {string} gdtfName The GDTF wheel name.
 * @property {'Color' | 'Gobo' | 'AnimationWheel' | 'Prism'} family The GDTF attribute family.
 * @property {string} attributePrefix The concrete attribute prefix, e.g. `Gobo2`.
 */

/**
 * @typedef {object} FunctionInfo
 * @property {string} attribute GDTF attribute; may contain one `(n)` placeholder that is resolved per DMX channel.
 * @property {Entity[] | null} physical Start and end entity of the capability's physical property, or null.
 * @property {Wheel | null} wheel The OFL wheel this function controls.
 * @property {number | null} wheelSlotIndex One-based GDTF wheel slot index, or null.
 * @property {boolean} isColorMacro Whether this function selects a color macro, which may get a virtual color wheel.
 * @property {[number, number] | null} fixedPhysical Physical values that are defined by the GDTF attribute's semantics, overriding `physical`.
 */

const colorIntensityAttributes = {
  'Red': 'ColorAdd_R',
  'Green': 'ColorAdd_G',
  'Blue': 'ColorAdd_B',
  'Cyan': 'ColorAdd_C',
  'Magenta': 'ColorAdd_M',
  'Yellow': 'ColorAdd_Y',
  'Amber': 'ColorAdd_RY',
  'White': 'ColorAdd_W',
  'Warm White': 'ColorAdd_WW',
  'Cold White': 'ColorAdd_CW',
  'UV': 'ColorAdd_UV',
  'Lime': 'ColorAdd_GY',
  'Indigo': 'ColorAdd_BM',
};

const bladePositions = ['Top', 'Right', 'Bottom', 'Left'];

/**
 * OFL keywords that only describe a relative position on a scale from 0 to 1.
 * They are only used for GDTF attributes whose physical unit is relative, too.
 */
const relativeKeywords = {
  off: 0,
  dark: 0,
  bright: 1,
  slow: 0,
  fast: 1,
  closed: 0,
  open: 1,
  narrow: 0,
  wide: 1,
  near: 0,
  far: 1,
  small: 0,
  big: 1,
  low: 0,
  high: 1,
  weak: 0,
  strong: 1,
};

const relativePhysicalUnits = new Set(['None', 'Percent', 'ColorComponent']);

/**
 * Conversion factors from OFL units to GDTF physical units.
 * @type {Record<string, Record<string, number>>}
 */
const unitConversions = {
  Percent: { '%': 0.01 },
  ColorComponent: { '%': 0.01 },
  None: { '%': 0.01 },
  Angle: { deg: 1 },
  AngularSpeed: { rpm: 6, Hz: 360 },
  Frequency: { Hz: 1, bpm: 1 / 60, rpm: 1 / 60 },
  Temperature: { K: 1 },
  Time: { s: 1, ms: 0.001 },
  Length: { m: 1 },
};

/**
 * @param {Fixture} fixture - The fixture.
 * @returns {Map<Wheel, WheelInfo>} GDTF information for every wheel.
 */
export function getWheelInfos(fixture) {
  const familyCounts = {};
  const usedNames = new Set();
  const wheelInfos = new Map();

  for (const wheel of fixture.wheels) {
    const family = getWheelFamily(wheel);
    familyCounts[family] = (familyCounts[family] ?? 0) + 1;

    wheelInfos.set(wheel, {
      wheel,
      gdtfName: getUniqueName(sanitizeName(wheel.name), usedNames),
      family,
      attributePrefix: `${family}${familyCounts[family]}`,
    });
  }

  return wheelInfos;
}

/**
 * @param {Wheel} wheel - An OFL wheel.
 * @returns {'Color' | 'Gobo' | 'AnimationWheel' | 'Prism'} The GDTF attribute family for this wheel.
 */
function getWheelFamily(wheel) {
  switch (wheel.type) {
    case 'Color': {
      return 'Color';
    }
    case 'AnimationGobo': {
      return 'AnimationWheel';
    }
    case 'Prism': {
      return 'Prism';
    }
    default: {
      // GDTF's Iris and Frost(n) attributes describe continuous features, so
      // wheels of fixed apertures or frost filters are selected like gobo wheels
      return 'Gobo';
    }
  }
}

/**
 * @param {Map<Wheel, WheelInfo>} wheelInfos - Result of {@link getWheelInfos}.
 * @returns {Record<string, number>} The first free `(n)` index per attribute family, so that non-wheel attributes don't reuse wheel numbers.
 */
export function getFirstFreeFamilyIndices(wheelInfos) {
  const firstFreeIndices = {};
  for (const { family } of wheelInfos.values()) {
    firstFreeIndices[family] = (firstFreeIndices[family] ?? 1) + 1;
  }
  return firstFreeIndices;
}

/**
 * Capability types that map to one GDTF attribute, with the capability property that holds the physical values.
 * @type {Record<string, [string, string | null]>}
 */
const simpleMappings = {
  NoFunction: ['NoFeature', null],
  Intensity: ['Dimmer', 'brightness'],
  ColorTemperature: ['CTC', 'colorTemperature'],
  Pan: ['Pan', 'angle'],
  Tilt: ['Tilt', 'angle'],
  PanContinuous: ['PanRotate', 'speed'],
  TiltContinuous: ['TiltRotate', 'speed'],
  StrobeSpeed: ['StrobeFrequency', 'speed'],
  StrobeDuration: ['StrobeDuration', 'duration'],
  Prism: ['Prism(n)', null],
  Effect: ['Effects(n)', null],
  EffectSpeed: ['Effects(n)Rate', 'speed'],
  EffectDuration: ['Effects(n)Fade', 'duration'],
  EffectParameter: ['Effects(n)Adjust1', 'parameter'],
  Zoom: ['Zoom', 'angle'],
  BeamAngle: ['Zoom', 'angle'],
  Focus: ['Focus(n)', 'distance'],
  Iris: ['Iris', 'openPercent'],
  Frost: ['Frost(n)', 'frostIntensity'],
  BladeSystemRotation: ['ShaperRot', 'angle'],
  Maintenance: ['Control(n)', 'parameter'],
};

/**
 * Maps an OFL capability to a GDTF channel function.
 * @param {Capability} capability - The OFL capability.
 * @param {Map<Wheel, WheelInfo>} wheelInfos - Result of {@link getWheelInfos}.
 * @returns {FunctionInfo} The GDTF channel function info.
 */
export function getFunctionInfo(capability, wheelInfos) {
  const info = getRawFunctionInfo(capability, wheelInfos);

  // the GDTF standard may have no attribute for some combinations, e.g. shaking a color wheel
  return isStandardAttribute(info.attribute)
    ? info
    : createFunctionInfo({ attribute: 'Function' });
}

/**
 * @param {string} attribute - A GDTF attribute, possibly with `(n)` placeholder.
 * @returns {boolean} Whether the attribute is defined in the GDTF standard.
 */
function isStandardAttribute(attribute) {
  return getAttributeDefinition(attribute.replace('(n)', '1')) !== null;
}

/**
 * @param {Partial<FunctionInfo> & { attribute: string }} properties - The function info's properties, others get default values.
 * @returns {FunctionInfo} The function info.
 */
function createFunctionInfo(properties) {
  return {
    physical: null,
    wheel: null,
    wheelSlotIndex: null,
    isColorMacro: false,
    fixedPhysical: null,
    ...properties,
  };
}

/**
 * @param {Capability} capability - The OFL capability.
 * @param {Map<Wheel, WheelInfo>} wheelInfos - Result of {@link getWheelInfos}.
 * @returns {FunctionInfo} The GDTF channel function info, the attribute may not be a standard one.
 */
function getRawFunctionInfo(capability, wheelInfos) {
  if (capability.type in simpleMappings) {
    const [attribute, physicalProperty] = simpleMappings[capability.type];
    return createFunctionInfo({ attribute, physical: physicalProperty ? capability[physicalProperty] : null });
  }

  switch (capability.type) {
    case 'ColorIntensity': {
      return createFunctionInfo({
        attribute: colorIntensityAttributes[capability.color] ?? 'Function',
        physical: capability.brightness,
      });
    }
    case 'ColorPreset': {
      return createFunctionInfo({ attribute: 'ColorMacro(n)', isColorMacro: true });
    }
    case 'PanTiltSpeed': {
      // PositionMSpeed is unitless in GDTF, so only relative speeds (or durations) are kept
      return createFunctionInfo({ attribute: 'PositionMSpeed', physical: capability.speed ?? capability.duration });
    }
    case 'ShutterStrobe': {
      return getShutterFunctionInfo(capability);
    }
    case 'WheelSlot':
    case 'WheelShake':
    case 'WheelRotation':
    case 'WheelSlotRotation': {
      return getWheelFunctionInfo(capability, wheelInfos.get(capability.wheels[0]));
    }
    case 'PrismRotation': {
      return createFunctionInfo(capability.speed ? { attribute: 'Prism(n)PosRotate', physical: capability.speed } : { attribute: 'Prism(n)Pos', physical: capability.angle });
    }
    case 'IrisEffect': {
      return createFunctionInfo({ attribute: getPulseAttribute('Iris', capability.effectName), physical: capability.speed });
    }
    case 'FrostEffect': {
      return createFunctionInfo({ attribute: getPulseAttribute('Frost(n)', capability.effectName), physical: capability.speed });
    }
    case 'BladeInsertion': {
      return createFunctionInfo({ attribute: `Blade${getBladeNumber(capability.blade)}A`, physical: capability.insertion });
    }
    case 'BladeRotation': {
      return createFunctionInfo({ attribute: `Blade${getBladeNumber(capability.blade)}Rot`, physical: capability.angle });
    }
    case 'Fog':
    case 'FogOutput':
    case 'FogType': {
      // selecting fog or haze (FogType) activates GDTF's Fog(n) or Haze(n) feature
      return createFunctionInfo({
        attribute: capability.fogType === 'Haze' ? 'Haze(n)' : 'Fog(n)',
        physical: capability.type === 'FogType' ? null : capability.fogOutput,
      });
    }
    default: {
      // Generic, Speed, Time, Rotation, BeamPosition, SoundSensitivity: no GDTF equivalent
      return createFunctionInfo({ attribute: 'Function' });
    }
  }
}

/**
 * @param {Capability} capability - A ShutterStrobe capability.
 * @returns {FunctionInfo} The GDTF channel function info.
 */
function getShutterFunctionInfo(capability) {
  // GDTF defines the physical value of Shutter(n) as 0 = closed, 1 = open
  if (capability.shutterEffect === 'Closed' || capability.shutterEffect === 'Open') {
    const value = capability.shutterEffect === 'Open' ? 1 : 0;
    return createFunctionInfo({ attribute: 'Shutter(n)', fixedPhysical: [value, value] });
  }
  return createFunctionInfo({ attribute: getShutterAttribute(capability), physical: capability.speed });
}

/**
 * @param {Capability} capability - A WheelSlot, WheelShake, WheelRotation or WheelSlotRotation capability.
 * @param {WheelInfo} wheelInfo - GDTF info of the capability's wheel.
 * @returns {FunctionInfo} The GDTF channel function info.
 */
function getWheelFunctionInfo(capability, wheelInfo) {
  const { wheel, attributePrefix: prefix } = wheelInfo;
  const slotIndex = getWheelSlotIndex(capability);

  switch (capability.type) {
    case 'WheelSlot': {
      return createFunctionInfo({ attribute: prefix, wheel, ...getWheelSlotPosition(capability, wheel) });
    }
    case 'WheelShake': {
      // selecting and shaking a slot in one function needs exactly one slot
      if (slotIndex !== null) {
        return createFunctionInfo({ attribute: `${prefix}SelectShake`, physical: capability.shakeSpeed, wheel, wheelSlotIndex: slotIndex });
      }
      const suffix = capability.isShaking === 'slot' ? 'PosShake' : 'WheelShake';
      return createFunctionInfo({ attribute: `${prefix}${suffix}`, physical: capability.shakeSpeed, wheel });
    }
    case 'WheelRotation': {
      return getWheelRotationFunctionInfo(capability, wheelInfo);
    }
    default: {
      // WheelSlotRotation; selecting and rotating a slot in one function needs exactly one slot
      return slotIndex === null || capability.speed === null ? getSlotRotationFunctionInfo(capability, wheelInfo) : createFunctionInfo({ attribute: `${prefix}SelectSpin`, physical: capability.speed, wheel, wheelSlotIndex: slotIndex });
    }
  }
}

/**
 * @param {Capability} capability - A WheelRotation capability.
 * @param {WheelInfo} wheelInfo - GDTF info of the capability's wheel.
 * @returns {FunctionInfo} The GDTF channel function info.
 */
function getWheelRotationFunctionInfo(capability, wheelInfo) {
  // an animation wheel's rotation is the animation itself, GDTF describes it as rotation of the wheel's slot
  if (wheelInfo.family === 'AnimationWheel') {
    return getSlotRotationFunctionInfo(capability, wheelInfo);
  }

  const { wheel, attributePrefix: prefix } = wheelInfo;
  return createFunctionInfo(capability.speed === null ? { attribute: `${prefix}WheelIndex`, physical: capability.angle, wheel } : { attribute: `${prefix}WheelSpin`, physical: capability.speed, wheel });
}

/**
 * @param {Capability} capability - A WheelRotation or WheelSlotRotation capability.
 * @param {WheelInfo} wheelInfo - GDTF info of the capability's wheel.
 * @returns {FunctionInfo} The GDTF channel function info for rotating the wheel's slots.
 */
function getSlotRotationFunctionInfo(capability, wheelInfo) {
  const { wheel, attributePrefix: prefix } = wheelInfo;
  return createFunctionInfo(capability.speed === null ? { attribute: `${prefix}Pos`, physical: capability.angle, wheel } : { attribute: `${prefix}PosRotate`, physical: capability.speed, wheel });
}

/**
 * GDTF describes wheel positions as a slot index plus an offset in the physical
 * values (e.g. -0.5 is halfway to the previous slot). The importer treats the
 * default physical range 0…1 as "no offset", so that combination is avoided.
 * @param {Capability} capability - A WheelSlot capability.
 * @param {Wheel} wheel - The capability's wheel.
 * @returns {{ wheelSlotIndex: number | null, fixedPhysical: [number, number] | null }} Slot index and offsets, or nulls if the slot numbers are unknown.
 */
function getWheelSlotPosition(capability, wheel) {
  const [start, end] = (capability.slotNumber ?? []).map((entity) => entity?.number);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { wheelSlotIndex: null, fixedPhysical: null };
  }

  const slotCount = wheel.slots.length;
  const lowestSlot = Math.floor(Math.min(start, end));
  let index = Math.min(Math.max(lowestSlot, 1), slotCount);
  if (start === index && end === index + 1) {
    index += index < slotCount ? 1 : -1;
  }

  const round = (number) => Number(number.toPrecision(12));
  return {
    wheelSlotIndex: index,
    fixedPhysical: [round(start - index), round(end - index)],
  };
}

/**
 * @param {Capability} capability - A capability with a slot number.
 * @returns {number | null} The one-based GDTF wheel slot index, or null if the capability doesn't select exactly one slot.
 */
function getWheelSlotIndex(capability) {
  const [start, end] = capability.slotNumber ?? [];
  return start && start.equals(end) && Number.isSafeInteger(start.number) ? start.number : null;
}

/**
 * @param {Capability} capability - A ShutterStrobe capability that is not just open or closed.
 * @returns {string} The GDTF shutter attribute.
 */
function getShutterAttribute(capability) {
  const random = capability.randomTiming ? 'Random' : '';
  switch (capability.shutterEffect) {
    case 'Strobe': {
      return `Shutter(n)Strobe${random}`;
    }
    case 'Pulse':
    case 'RampUpDown': {
      return `Shutter(n)Strobe${random}Pulse`;
    }
    case 'RampUp': {
      return `Shutter(n)Strobe${random}PulseOpen`;
    }
    case 'RampDown': {
      return `Shutter(n)Strobe${random}PulseClose`;
    }
    default: {
      // Lightning, Spikes, Burst
      return 'Shutter(n)StrobeEffect';
    }
  }
}

/**
 * Derives GDTF's pulse attributes for irises and frost from OFL's free-text effect name.
 * @param {string} base - `Iris` or `Frost(n)`.
 * @param {string} effectName - The OFL effect name.
 * @returns {string} The GDTF attribute.
 */
function getPulseAttribute(base, effectName) {
  const name = effectName.toLowerCase();
  const random = name.includes('random') ? 'Random' : '';
  if (name.includes('open') || name.includes('ramp up')) {
    return `${base}${random}PulseOpen`;
  }
  if (name.includes('clos') || name.includes('ramp down')) {
    return `${base}${random}PulseClose`;
  }
  return `${base}Strobe${random}`;
}

/**
 * @param {string | number} blade - OFL blade position or number.
 * @returns {number} The GDTF blade number.
 */
function getBladeNumber(blade) {
  const index = bladePositions.indexOf(blade);
  return index === -1 ? blade : index + 1;
}

/**
 * Converts OFL start/end entities into GDTF physical values, only if an exact conversion is possible.
 * @param {Entity[] | null} entities - Start and end entity.
 * @param {string} physicalUnit - The GDTF attribute's physical unit.
 * @returns {[number, number] | null} The GDTF physical values, or null if they can't be determined.
 */
export function getPhysicalValues(entities, physicalUnit) {
  if (!entities) {
    return null;
  }
  const values = entities.map((entity) => convertEntity(entity, physicalUnit));
  return values.every((value) => value !== null) ? values : null;
}

/**
 * @param {Entity} entity - An OFL entity.
 * @param {string} physicalUnit - The GDTF physical unit.
 * @returns {number | null} The value in the GDTF unit, or null if it can't be converted.
 */
function convertEntity(entity, physicalUnit) {
  if (entity.keyword !== null) {
    if (physicalUnit === 'Time' && entity.keyword === 'instant') {
      return 0;
    }
    if (entity.keyword === 'stop' && ['AngularSpeed', 'Frequency'].includes(physicalUnit)) {
      return 0;
    }
    return relativePhysicalUnits.has(physicalUnit) && Object.hasOwn(relativeKeywords, entity.keyword)
      ? relativeKeywords[entity.keyword]
      : null;
  }

  const factor = unitConversions[physicalUnit]?.[entity.unit];
  return factor === undefined ? null : Number((entity.number * factor).toPrecision(12));
}

/**
 * GDTF names must only contain certain characters and are used in dot-separated node references.
 * @param {string} name - The name.
 * @returns {string} The sanitized name.
 */
export function sanitizeName(name) {
  return name
    .replaceAll('.', ',')
    .replaceAll('…', '-')
    .replaceAll('°', 'deg')
    .replaceAll('&', '+')
    .normalize('NFD')
    .replaceAll(/[^\w#%()*+,\-/:;<=>@` "']+/g, ' ')
    .replaceAll(/ {2,}/g, ' ')
    .trim();
}

/**
 * @param {string} name - Desired name.
 * @param {Set<string>} usedNames - Already used names; the returned name is added.
 * @returns {string} A unique name, made unique by appending a number if necessary.
 */
export function getUniqueName(name, usedNames) {
  let uniqueName = name;
  let index = 2;
  while (usedNames.has(uniqueName)) {
    uniqueName = `${name} ${index}`;
    index++;
  }
  usedNames.add(uniqueName);
  return uniqueName;
}
