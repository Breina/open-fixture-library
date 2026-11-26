import { describe, expect, it } from 'vitest';
import importJson from '../lib/import-json.js';
import CoarseChannel from '../lib/model/CoarseChannel.js';
import FineChannel from '../lib/model/FineChannel.js';
import Fixture from '../lib/model/Fixture.js';
import Manufacturer from '../lib/model/Manufacturer.js';
import NullChannel from '../lib/model/NullChannel.js';
import SwitchingChannel from '../lib/model/SwitchingChannel.js';
import { fixtureFromRepository } from '../lib/model.js';
import { exportFixtures } from '../plugins/gdtf/export.js';
import { importFixtures } from '../plugins/gdtf/import.js';
import { checkFixture } from './fixture-valid.js';
/** @import AbstractChannel from '../lib/model/AbstractChannel.js' */
/** @import Capability from '../lib/model/Capability.js' */
/** @import Mode from '../lib/model/Mode.js' */

/** @type {{ man: string, key: string }[]} */
const testFixtures = await importJson('./test-fixtures.json', import.meta.url);

/**
 * OFL capability types that GDTF has no equivalent attribute for, with the type they are imported as.
 */
const typesWithoutGdtfEquivalent = {
  Speed: 'Generic',
  Time: 'Generic',
  Rotation: 'Generic',
  SoundSensitivity: 'Generic',
  BeamPosition: 'Generic',
  BeamAngle: 'Zoom',
  FogOutput: 'Fog',
  FogType: 'Fog',
};

describe.each(testFixtures)('GDTF export and re-import of $man/$key', ({ man, key }) => {
  const roundTrip = getRoundTrip(man, key);

  it('is a valid OFL fixture after the round trip', async () => {
    const { fixture, importedKey, importedJson } = await roundTrip;
    const [importedManufacturerKey, importedFixtureKey] = importedKey.split('/', 2);

    // GDTF has neither categories nor helpWanted, so errors that the original would have without them are expected
    const stripHelpWanted = (object) => JSON.parse(JSON.stringify(object, (property, value) => (property === 'helpWanted' ? undefined : value)));
    const baseline = await checkFixture(man, key, stripHelpWanted(fixture.jsonObject));
    const validation = await checkFixture(importedManufacturerKey, importedFixtureKey, {
      ...structuredClone(importedJson),
      categories: fixture.categories,
    });

    const baselineErrorTemplates = new Set(baseline.errors.map((error) => getErrorTemplate(error)));
    const newErrors = validation.errors.filter((error) => !baselineErrorTemplates.has(getErrorTemplate(error)));
    expect(newErrors).toEqual([]);
  });

  it('keeps the channels of all modes', async () => {
    const { fixture, importedFixture } = await roundTrip;

    for (const [modeIndex, mode] of fixture.modes.entries()) {
      const importedMode = importedFixture.modes[modeIndex];
      const expectedChannels = mode.channels.map((channel) => describeChannel(channel, mode, getExpectedImportedType));
      const importedChannels = importedMode.channels.map((channel) => describeChannel(channel, importedMode, (capability) => capability.type));

      expect(importedChannels, `mode '${mode.name}'`).toEqual(expectedChannels);
    }
  });

  it('keeps default values', async () => {
    const { fixture, importedFixture } = await roundTrip;

    for (const [modeIndex, mode] of fixture.modes.entries()) {
      const importedMode = importedFixture.modes[modeIndex];
      const defaultValues = mode.channels.flatMap((channel, channelIndex) => {
        const importedChannel = importedMode.channels[channelIndex];
        if (!(channel instanceof CoarseChannel) || !(importedChannel instanceof CoarseChannel)) {
          return [];
        }
        const resolution = Math.min(channel.getResolutionInMode(mode), importedChannel.getResolutionInMode(importedMode));
        return {
          original: channel.getDefaultValueWithResolution(resolution),
          imported: importedChannel.getDefaultValueWithResolution(resolution),
        };
      });

      expect(defaultValues.map(({ imported }) => imported), `mode '${mode.name}'`)
        .toEqual(defaultValues.map(({ original }) => original));
    }
  });

  it('keeps the matrix pixel of matrix channels', async () => {
    const { fixture, importedFixture } = await roundTrip;

    for (const [modeIndex, mode] of fixture.modes.entries()) {
      // switching channels inside a pixel can't use GDTF geometry references, so such modes use explicit pixel geometries
      const hasSwitchingMatrixChannels = mode.channels.some((channel) => channel instanceof SwitchingChannel && channel.pixelKey !== null);
      if (hasSwitchingMatrixChannels) {
        continue;
      }

      const importedMode = importedFixture.modes[modeIndex];
      const pixelKeys = mode.channels.map((channel) => channel.pixelKey);
      const importedPixelKeys = importedMode.channels.map((channel) => channel.pixelKey);
      expect(importedPixelKeys, `mode '${mode.name}'`).toEqual(pixelKeys);
    }
  });
});

/**
 * @param {string} manufacturerKey - The manufacturer key.
 * @param {string} fixtureKey - The fixture key.
 * @returns {Promise<object>} The original fixture, the imported JSON and the imported fixture model.
 */
async function getRoundTrip(manufacturerKey, fixtureKey) {
  const fixture = await fixtureFromRepository(manufacturerKey, fixtureKey);
  const [file] = await exportFixtures([fixture], { baseDirectory: '.', date: new Date() });
  const imported = await importFixtures(file.content, file.name, 'GDTF round trip test');

  const [[importedKey, importedJson]] = Object.entries(imported.fixtures);
  const [importedManufacturerKey, importedFixtureKey] = importedKey.split('/', 2);
  const manufacturer = new Manufacturer(importedManufacturerKey, imported.manufacturers[importedManufacturerKey]);
  const importedFixture = new Fixture(manufacturer, importedFixtureKey, structuredClone(importedJson));

  return { fixture, importedKey, importedJson, importedFixture };
}

/**
 * @param {Capability} capability - A capability of the original fixture.
 * @returns {string} The capability type that the GDTF round trip should result in.
 */
function getExpectedImportedType(capability) {
  if (capability.type in typesWithoutGdtfEquivalent) {
    return typesWithoutGdtfEquivalent[capability.type];
  }

  // GDTF describes an animation wheel's rotation as rotation of the wheel's slot
  if (capability.type === 'WheelRotation' && capability.wheels[0].type === 'AnimationGobo') {
    return 'WheelSlotRotation';
  }

  // GDTF's only frost effects are opening and closing pulses
  if (capability.type === 'FrostEffect' && !/open|clos|ramp up|ramp down/i.test(capability.effectName)) {
    return 'Generic';
  }

  return capability.type;
}

/**
 * @param {AbstractChannel | null} channel - A mode's channel.
 * @param {Mode} mode - The mode.
 * @param {(capability: Capability) => string} getType - Returns the type to compare for a capability.
 * @returns {string} A description of the channel's function and DMX ranges.
 */
function describeChannel(channel, mode, getType) {
  if (isUnusedChannel(channel)) {
    return 'unused';
  }

  if (channel instanceof FineChannel) {
    return `fine channel (resolution ${channel.resolution})`;
  }

  if (channel instanceof SwitchingChannel) {
    // switch targets with identical content can't be distinguished in GDTF, so they are merged on import
    const targets = new Set(channel.switchToChannels.map((target) => describeSwitchTarget(target, getType)));
    return `switching { ${targets.values().toArray().toSorted((a, b) => a.localeCompare(b)).join(' | ')} }`;
  }

  return describeCapabilities(channel, channel.getResolutionInMode(mode), getType);
}

/**
 * @param {AbstractChannel} target - A switching channel's target.
 * @param {(capability: Capability) => string} getType - Returns the type to compare for a capability.
 * @returns {string} A description of the target.
 */
function describeSwitchTarget(target, getType) {
  if (isUnusedChannel(target)) {
    return 'unused';
  }
  return target instanceof FineChannel
    ? 'fine channel'
    : describeCapabilities(target, 1, getType);
}

/**
 * @param {CoarseChannel} channel - A channel.
 * @param {number} resolution - The resolution to describe DMX ranges in.
 * @param {(capability: Capability) => string} getType - Returns the type to compare for a capability.
 * @returns {string} A description of the capabilities' types and DMX ranges.
 */
function describeCapabilities(channel, resolution, getType) {
  return channel.capabilities.map((capability) => {
    const { start, end } = capability.getDmxRangeWithResolution(resolution);
    return `${getType(capability)} ${start}…${end}`;
  }).join(', ');
}

/**
 * @param {AbstractChannel | null} channel - A channel.
 * @returns {boolean} Whether the channel has no function, which is the same for GDTF as an unused channel.
 */
function isUnusedChannel(channel) {
  const hasOnlyNoFunction = channel instanceof CoarseChannel && channel.capabilities.every((capability) => capability.type === 'NoFunction');
  return channel === null || channel instanceof NullChannel || hasOnlyNoFunction;
}

/**
 * @param {string} error - A validation error message.
 * @returns {string} The message without channel / capability names and numbers.
 */
function getErrorTemplate(error) {
  return error.replaceAll(/'[^']*'/g, '\'…\'').replaceAll(/\([^)]*\)/g, '(…)').replaceAll(/\d+/g, 'N');
}
