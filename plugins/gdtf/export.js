import { createHash } from 'crypto';
import JSZip from 'jszip';
import xmlbuilder from 'xmlbuilder';
import CoarseChannel from '../../lib/model/CoarseChannel.js';
import SwitchingChannel from '../../lib/model/SwitchingChannel.js';
import { getAttributeDefinition } from './attribute-definitions.js';
import {
  getFirstFreeFamilyIndices,
  getPhysicalValues,
  getUniqueName,
  getWheelInfos,
  sanitizeName,
} from './export-capabilities.js';
import { Layout } from './export-layout.js';
/** @import AbstractChannel from '../../lib/model/AbstractChannel.js' */
/** @import Fixture from '../../lib/model/Fixture.js' */
/** @import WheelSlot from '../../lib/model/WheelSlot.js' */
/** @import { FunctionSpec, GeometryNode, ModeLayout, Unit, Variant } from './export-layout.js' */

export const version = '1.0.0';

const GDTF_DATA_VERSION = '1.2';
const MAX_MEDIA_RESOLUTION = 1024;

const dmxConnectorTypes = {
  '3-pin': ['XLR3'],
  '3-pin (swapped +/-)': ['XLR3'],
  '3-pin XLR IP65': ['XLR3'],
  '5-pin': ['XLR5'],
  '5-pin XLR IP65': ['XLR5'],
  '3-pin and 5-pin': ['XLR3', 'XLR5'],
  '3.5mm stereo jack': ['MSTJ'],
  'RJ45': ['RJ45'],
};

/**
 * @typedef {object} ModeCondition
 * @property {string} modeMaster Name of the trigger DMX channel.
 * @property {string} modeFrom Start of the trigger's DMX range.
 * @property {string} modeTo End of the trigger's DMX range.
 * @property {boolean} containsTriggerDefault Whether the trigger channel's default value is in this range.
 */

/**
 * @param {Fixture[]} fixtures - An array of Fixture objects.
 * @param {object} options - Global options, including:
 * @param {string} options.baseDirectory - Absolute path to OFL's root directory.
 * @param {Date} options.date - The current time.
 * @param {string | undefined} options.displayedPluginVersion - Replacement for plugin version if the plugin version is used in export.
 * @returns {Promise<object[], Error>} The generated files.
 */
export async function exportFixtures(fixtures, options) {
  return Promise.all(fixtures.map(async (fixture) => {
    try {
      const { descriptionXml, mediaFiles } = new FixtureExporter(fixture, options).export();

      const zip = new JSZip();
      zip.file('description.xml', descriptionXml);
      for (const { path, data } of mediaFiles) {
        zip.file(path, data);
      }

      return {
        name: `${sanitizeFileName(fixture.manufacturer.name)}@${sanitizeFileName(fixture.name)}@OFL.gdtf`,
        content: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
        mimetype: 'application/zip',
        fixtures: [fixture],
      };
    }
    catch (error) {
      throw new Error(`Exporting fixture ${fixture.manufacturer.key}/${fixture.key} failed: ${error}`, {
        cause: error,
      });
    }
  }));
}

/**
 * Converts one OFL fixture to a GDTF description.xml and its resource files.
 */
class FixtureExporter {
  /**
   * @param {Fixture} fixture - The fixture to export.
   * @param {object} options - Global options, see {@link exportFixtures}.
   */
  constructor(fixture, options) {
    this.fixture = fixture;
    this.options = options;
    this.wheelInfos = getWheelInfos(fixture);
    this.layout = new Layout(fixture, this.wheelInfos, getFirstFreeFamilyIndices(this.wheelInfos));

    /** @type {Set<string>} */
    this.usedAttributes = new Set();
    /** @type {Set<string>} */
    this.usedWheelNames = new Set(this.wheelInfos.values().map(({ gdtfName }) => gdtfName));
    /** @type {Map<string, { name: string, slots: object[], slotIndices: Map<object, number> } | null>} Virtual color macro wheels by assignment key. */
    this.colorMacroWheels = new Map();
    /** @type {{ path: string, data: Buffer, resource: object, mediaFileName: string }[]} */
    this.mediaFiles = [];
    /** @type {string | null} */
    this.bodyModel = null;
    /** @type {string | null} */
    this.pixelModel = null;
  }

  /**
   * @returns {{ descriptionXml: string, mediaFiles: { path: string, data: Buffer }[] }} The export result.
   */
  export() {
    const fixture = this.fixture;

    // these collect used attributes, virtual wheels, media files and models that are needed later
    const dmxModes = this.layout.modeLayouts.map((modeLayout) => this._getDmxMode(modeLayout));
    const wheels = this._getWheels();
    const models = this._getModels();

    const fixtureType = {
      '@Name': sanitizeName(fixture.name),
      '@ShortName': fixture.shortName,
      '@LongName': fixture.name,
      '@Manufacturer': fixture.manufacturer.name,
      '@Description': fixture.hasComment ? fixture.comment : '',
      '@FixtureTypeID': getFixtureTypeId(fixture),
      '@RefFT': '',
      'AttributeDefinitions': this._getAttributeDefinitions(),
      'Wheels': wheels,
      'PhysicalDescriptions': this._getPhysicalDescriptions(),
      'Models': models,
      'Geometries': this._getGeometries(),
      'DMXModes': { DMXMode: dmxModes },
      'Revisions': this._getRevisions(),
      'FTPresets': {},
      'Protocols': this._getProtocols(),
    };

    const descriptionXml = xmlbuilder.begin()
      .declaration('1.0', 'utf-8', true)
      .element({
        GDTF: {
          '@DataVersion': GDTF_DATA_VERSION,
          'FixtureType': fixtureType,
        },
      })
      .end({ pretty: true });

    return {
      descriptionXml,
      mediaFiles: this.mediaFiles.map(({ path, data }) => ({ path, data })),
    };
  }

  /**
   * @param {ModeLayout} modeLayout - The mode layout.
   * @returns {object} The xmlbuilder object for <DMXMode>.
   */
  _getDmxMode(modeLayout) {
    const { mode } = modeLayout;
    const variant = this.layout.getVariant(modeLayout);

    const dmxMode = {
      '@Name': sanitizeName(mode.name),
      '@Geometry': this.layout.getNodeName(this.layout.mainSkeleton.root, variant),
    };
    if (mode.hasShortName) {
      dmxMode['@Description'] = mode.shortName;
    }
    dmxMode.DMXChannels = {
      DMXChannel: modeLayout.units.map((unit) => this._getDmxChannel(unit, modeLayout)),
    };
    dmxMode.Relations = {};
    dmxMode.FTMacros = {};
    return dmxMode;
  }

  /**
   * @param {Unit} unit - The unit to export.
   * @param {ModeLayout} modeLayout - The unit's mode layout.
   * @returns {object} The xmlbuilder object for <DMXChannel>.
   */
  _getDmxChannel(unit, modeLayout) {
    const { assignment } = unit;
    const variant = this.layout.getVariant(modeLayout);
    const dmxChannelName = this.layout.getDmxChannelName(unit, modeLayout);

    this.usedAttributes.add(assignment.logicalAttribute);
    const channelFunctions = this._getChannelFunctions(unit, modeLayout);
    const initialFunction = channelFunctions.find((channelFunction) => channelFunction.isInitial) ?? channelFunctions[0];

    const dmxChannel = {
      '@DMXBreak': unit.role === 'template' ? 'Overwrite' : 1,
      '@Offset': unit.offsets.join(','),
      '@InitialFunction': `${dmxChannelName}.${assignment.logicalAttribute}.${initialFunction.xml['@Name']}`,
      '@Highlight': 'None',
      '@Geometry': this.layout.getNodeName(assignment.node, variant),
      'LogicalChannel': {
        '@Attribute': assignment.logicalAttribute,
        'ChannelFunction': channelFunctions.map(({ xml }) => xml),
      },
    };

    const highlightChannel = unit.main instanceof SwitchingChannel ? unit.main.defaultChannel : unit.main;
    if (highlightChannel instanceof CoarseChannel && highlightChannel.hasHighlightValue) {
      const resolution = unit.getResolutionFor(highlightChannel);
      dmxChannel['@Highlight'] = `${highlightChannel.getHighlightValueWithResolution(resolution)}/${resolution}`;
    }

    return dmxChannel;
  }

  /**
   * Creates the channel functions of a unit. Consecutive capabilities with the
   * same attribute are combined into one channel function with multiple channel sets.
   * @param {Unit} unit - The unit.
   * @param {ModeLayout} modeLayout - The unit's mode layout.
   * @returns {{ xml: object, isInitial: boolean }[]} The channel functions.
   */
  _getChannelFunctions(unit, modeLayout) {
    const { assignment } = unit;
    const isSwitching = unit.main instanceof SwitchingChannel;
    const specsBySwitchTarget = Map.groupBy(assignment.functions, (spec) => spec.switchTarget);

    const channelFunctions = [];
    for (const [switchTarget, specs] of specsBySwitchTarget) {
      const groups = groupFunctionSpecs(specs.map((spec) => this._getSetData(spec, unit)));
      const modeConditions = isSwitching ? this._getModeConditions(unit, modeLayout, switchTarget) : [null];
      const isDefaultTarget = !isSwitching || switchTarget === unit.main.defaultChannel;

      for (const modeCondition of modeConditions) {
        for (const group of groups) {
          channelFunctions.push(this._getChannelFunction(unit, group, {
            modeCondition,
            functionNumber: channelFunctions.length + 1,
            isDefaultTarget,
          }));
        }
      }
    }

    return channelFunctions;
  }

  /**
   * @param {Unit} unit - A unit whose main channel is a switching channel.
   * @param {ModeLayout} modeLayout - The unit's mode layout.
   * @param {AbstractChannel} switchTarget - One of the switching channel's targets.
   * @returns {ModeCondition[]} The trigger ranges that activate the switch target.
   */
  _getModeConditions(unit, modeLayout, switchTarget) {
    const switchingChannel = unit.main;
    const triggerChannel = switchingChannel.triggerChannel;
    const triggerUnit = modeLayout.units.find((candidate) => candidate.main === triggerChannel);
    if (!triggerUnit) {
      throw new Error(`Trigger channel '${triggerChannel.key}' of switching channel '${switchingChannel.key}' has no DMX channel in mode '${modeLayout.mode.shortName}'.`);
    }

    const modeMaster = this.layout.getDmxChannelName(triggerUnit, modeLayout);
    const resolution = triggerChannel.maxResolution;
    const triggerDefault = triggerChannel.getDefaultValueWithResolution(resolution);

    return switchingChannel.triggerRanges[switchTarget.key].map((range) => ({
      modeMaster,
      modeFrom: `${range.start}/${resolution}`,
      modeTo: `${range.end}/${resolution}`,
      containsTriggerDefault: range.contains(triggerDefault),
    }));
  }

  /**
   * @param {FunctionSpec} spec - A function spec.
   * @param {Unit} unit - The unit it belongs to.
   * @returns {object} DMX and physical data of the channel set created from this spec.
   */
  _getSetData(spec, unit) {
    const resolution = unit.getResolutionFor(spec.sourceChannel);
    const range = spec.capability
      ? spec.capability.getDmxRangeWithResolution(resolution)
      : { start: 0, end: (256 ** resolution) - 1 };
    const { physicalUnit } = getAttributeDefinition(spec.info.attribute);

    return {
      spec,
      resolution,
      dmxFrom: range.start,
      dmxTo: range.end,
      physical: spec.info.fixedPhysical ?? getPhysicalValues(spec.info.physical, physicalUnit),
      name: sanitizeName(spec.capability ? spec.capability.name : spec.placeholderName),
    };
  }

  /**
   * @param {Unit} unit - The unit.
   * @param {object[]} group - Set data of consecutive specs with the same attribute (see {@link groupFunctionSpecs}).
   * @param {object} context - Context of the channel function.
   * @param {ModeCondition | null} context.modeCondition - The ModeMaster condition, if any.
   * @param {number} context.functionNumber - One-based index of the channel function in its logical channel.
   * @param {boolean} context.isDefaultTarget - Whether the function belongs to the channel that is active by default.
   * @returns {{ xml: object, isInitial: boolean }} The channel function.
   */
  _getChannelFunction(unit, group, { modeCondition, functionNumber, isDefaultTarget }) {
    const [first] = group;
    const last = group.at(-1);
    const { spec, resolution } = first;
    const attribute = spec.info.attribute;
    this.usedAttributes.add(attribute);

    let defaultValue = first.dmxFrom;
    let isContainsChannelDefault = !(spec.sourceChannel instanceof CoarseChannel);
    if (spec.sourceChannel instanceof CoarseChannel) {
      const channelDefault = spec.sourceChannel.getDefaultValueWithResolution(resolution);
      if (channelDefault >= first.dmxFrom && channelDefault <= last.dmxTo) {
        defaultValue = channelDefault;
        isContainsChannelDefault = true;
      }
    }

    const xml = {
      '@Name': `${attribute} ${functionNumber}`,
      '@Attribute': attribute,
      '@DMXFrom': `${first.dmxFrom}/${resolution}`,
      '@Default': `${defaultValue}/${resolution}`,
    };

    if (group.every((setData) => setData.physical !== null)) {
      xml['@PhysicalFrom'] = first.physical[0];
      xml['@PhysicalTo'] = last.physical[1];
    }

    const wheelName = this._getWheelName(unit, spec);
    if (wheelName) {
      xml['@Wheel'] = wheelName;
    }

    if (modeCondition) {
      xml['@ModeMaster'] = modeCondition.modeMaster;
      xml['@ModeFrom'] = modeCondition.modeFrom;
      xml['@ModeTo'] = modeCondition.modeTo;
    }

    xml.ChannelSet = group.map((setData) => {
      const channelSet = {
        '@Name': setData.name,
        '@DMXFrom': `${setData.dmxFrom}/${resolution}`,
      };
      if (setData.physical) {
        channelSet['@PhysicalFrom'] = setData.physical[0];
        channelSet['@PhysicalTo'] = setData.physical[1];
      }
      const wheelSlotIndex = this._getWheelSlotIndex(unit, setData.spec);
      if (wheelSlotIndex !== null) {
        channelSet['@WheelSlotIndex'] = wheelSlotIndex;
      }
      return channelSet;
    });

    const isActiveByDefault = modeCondition === null || modeCondition.containsTriggerDefault;
    return {
      xml,
      isInitial: isDefaultTarget && isActiveByDefault && isContainsChannelDefault,
    };
  }

  /**
   * @param {Unit} unit - The unit.
   * @param {FunctionSpec} spec - A function spec.
   * @returns {string | null} The GDTF wheel this function references.
   */
  _getWheelName(unit, spec) {
    if (spec.info.wheel) {
      return this.wheelInfos.get(spec.info.wheel).gdtfName;
    }
    if (spec.info.isColorMacro) {
      return this._getColorMacroWheel(unit)?.name ?? null;
    }
    return null;
  }

  /**
   * @param {Unit} unit - The unit.
   * @param {FunctionSpec} spec - A function spec.
   * @returns {number | null} The one-based wheel slot index this channel set selects.
   */
  _getWheelSlotIndex(unit, spec) {
    if (spec.info.wheelSlotIndex !== null) {
      return spec.info.wheelSlotIndex;
    }
    if (spec.info.isColorMacro) {
      return this._getColorMacroWheel(unit)?.slotIndices.get(spec.capability) ?? null;
    }
    return null;
  }

  /**
   * Color presets with known colors are described with a virtual color wheel,
   * which is a common GDTF convention.
   * @param {Unit} unit - The unit.
   * @returns {{ name: string, slots: object[], slotIndices: Map<object, number> } | null} The virtual wheel, or null if no preset has a known color.
   */
  _getColorMacroWheel(unit) {
    const key = unit.assignment.key;
    if (this.colorMacroWheels.has(key)) {
      return this.colorMacroWheels.get(key);
    }

    const presetSpecs = unit.assignment.functions.filter((spec) => spec.info.isColorMacro && spec.capability);
    if (presetSpecs.every((spec) => getSingleColor(spec.capability.colors) === null)) {
      this.colorMacroWheels.set(key, null);
      return null;
    }

    const usedSlotNames = new Set();
    const slotIndices = new Map();
    const slots = presetSpecs.map((spec, index) => {
      slotIndices.set(spec.capability, index + 1);
      const slot = { '@Name': getUniqueName(sanitizeName(spec.capability.name), usedSlotNames) };
      const color = getSingleColor(spec.capability.colors);
      if (color) {
        slot['@Color'] = getCieColor(color);
      }
      return slot;
    });

    const wheel = {
      name: getUniqueName(sanitizeName(`${unit.main.name} Color Macros`), this.usedWheelNames),
      slots,
      slotIndices,
    };
    this.colorMacroWheels.set(key, wheel);
    return wheel;
  }

  /**
   * @returns {object} The xmlbuilder object for <AttributeDefinitions>.
   */
  _getAttributeDefinitions() {
    const definitions = new Map();
    const addDefinition = (attribute) => {
      if (definitions.has(attribute)) {
        return;
      }
      const definition = getAttributeDefinition(attribute);
      if (!definition) {
        throw new Error(`GDTF attribute '${attribute}' is not defined in the GDTF standard.`);
      }
      definitions.set(attribute, definition);
      if (definition.mainAttribute) {
        addDefinition(definition.mainAttribute);
      }
    };
    for (const attribute of this.usedAttributes) {
      addDefinition(attribute);
    }

    const sortedDefinitions = definitions.values().toArray().toSorted((a, b) => a.name.localeCompare(b.name));
    const activationGroups = [...new Set(sortedDefinitions.map((definition) => definition.activationGroup).filter(Boolean))];

    const featureGroups = new Map();
    for (const { feature } of sortedDefinitions) {
      const [featureGroup, featureName] = feature.split('.', 2);
      if (!featureGroups.has(featureGroup)) {
        featureGroups.set(featureGroup, new Set());
      }
      featureGroups.get(featureGroup).add(featureName);
    }

    return {
      ActivationGroups: {
        ActivationGroup: activationGroups.map((name) => ({ '@Name': name })),
      },
      FeatureGroups: {
        FeatureGroup: [...featureGroups].map(([name, features]) => ({
          '@Name': name,
          '@Pretty': name,
          'Feature': [...features].map((featureName) => ({ '@Name': featureName })),
        })),
      },
      Attributes: {
        Attribute: sortedDefinitions.map((definition) => {
          const attributeXml = {
            '@Name': definition.name,
            '@Pretty': definition.pretty,
          };
          if (definition.activationGroup) {
            attributeXml['@ActivationGroup'] = definition.activationGroup;
          }
          attributeXml['@Feature'] = definition.feature;
          if (definition.mainAttribute) {
            attributeXml['@MainAttribute'] = definition.mainAttribute;
          }
          attributeXml['@PhysicalUnit'] = definition.physicalUnit;
          if (definition.color) {
            attributeXml['@Color'] = definition.color;
          }
          return attributeXml;
        }),
      },
    };
  }

  /**
   * @returns {object} The xmlbuilder object for <Wheels>.
   */
  _getWheels() {
    const usedMediaNames = new Set();

    const wheels = this.wheelInfos.values().map(({ gdtfName, wheel }) => ({
      '@Name': gdtfName,
      'Slot': wheel.slots.map((slot, slotIndex) => this._getWheelSlot(wheel.slots, slotIndex, usedMediaNames)),
    })).toArray();

    for (const colorMacroWheel of this.colorMacroWheels.values()) {
      if (colorMacroWheel) {
        wheels.push({
          '@Name': colorMacroWheel.name,
          'Slot': colorMacroWheel.slots,
        });
      }
    }

    return wheels.length > 0 ? { Wheel: wheels } : {};
  }

  /**
   * @param {WheelSlot[]} slots - All slots of the wheel.
   * @param {number} slotIndex - Zero-based index of the slot.
   * @param {Set<string>} usedMediaNames - Already used media file names.
   * @returns {object} The xmlbuilder object for <Slot>.
   */
  _getWheelSlot(slots, slotIndex, usedMediaNames) {
    const slot = slots[slotIndex];
    const name = sanitizeName(slot.name);
    const isDuplicate = slots.some((otherSlot, index) => index !== slotIndex && sanitizeName(otherSlot.name) === name);
    const slotXml = { '@Name': isDuplicate ? `${name} ${slotIndex + 1}` : name };

    if (slot.colors?.length === 1) {
      slotXml['@Color'] = getCieColor(slot.colors[0]);
    }

    const mediaFileName = this._addGoboMedia(slot, usedMediaNames);
    if (mediaFileName) {
      slotXml['@MediaFileName'] = mediaFileName;
    }

    return slotXml;
  }

  /**
   * Adds the slot's gobo image to the GDTF archive, if it is a PNG image within GDTF's size limits.
   * @param {WheelSlot} slot - A wheel slot.
   * @param {Set<string>} usedMediaNames - Already used media file names.
   * @returns {string | null} The media file name (without extension) or null if no image was added.
   */
  _addGoboMedia(slot, usedMediaNames) {
    const resource = slot.resource;
    if (!resource || typeof resource !== 'object' || !resource.hasImage || !resource.imageMimeType.startsWith('image/png')) {
      return null;
    }

    const existing = this.mediaFiles.find((mediaFile) => mediaFile.resource === resource);
    if (existing) {
      return existing.mediaFileName;
    }

    const data = resource.imageEncoding === 'base64'
      ? Buffer.from(resource.imageData, 'base64')
      : Buffer.from(resource.imageData);
    const size = getPngSize(data);
    if (!size || size.width > MAX_MEDIA_RESOLUTION || size.height > MAX_MEDIA_RESOLUTION) {
      return null;
    }

    const mediaFileName = getUniqueName(sanitizeFileName(resource.key ?? resource.name), usedMediaNames);
    this.mediaFiles.push({ path: `wheels/${mediaFileName}.png`, data, resource, mediaFileName });
    return mediaFileName;
  }

  /**
   * @returns {object} The xmlbuilder object for <PhysicalDescriptions>, only containing data known by OFL.
   */
  _getPhysicalDescriptions() {
    const physical = this.fixture.physical;
    if (!physical) {
      return {};
    }

    const usedConnectorNames = new Set();
    const connectors = [];

    const dmxConnector = physical.DMXconnector;
    const dmxTypes = dmxConnectorTypes[dmxConnector] ?? (dmxConnector ? [sanitizeName(dmxConnector)] : []);
    for (const type of dmxTypes) {
      connectors.push({ '@Name': getUniqueName(`DMX ${type}`, usedConnectorNames), '@Type': type });
    }

    let powerConnectorName = null;
    for (const [connector, usage] of Object.entries(physical.powerConnectors)) {
      const name = getUniqueName(sanitizeName(connector), usedConnectorNames);
      connectors.push({ '@Name': name, '@Type': sanitizeName(connector) });
      if (powerConnectorName === null && usage !== 'output only') {
        powerConnectorName = name;
      }
    }

    const properties = {};
    if (physical.weight !== null) {
      properties.Weight = { '@Value': physical.weight };
    }
    if (powerConnectorName !== null && physical.power !== null) {
      // GDTF's power consumption must belong to a connector
      properties.PowerConsumption = { '@Value': physical.power, '@Connector': powerConnectorName };
    }

    const physicalDescriptions = {};
    if (connectors.length > 0) {
      physicalDescriptions.Connectors = { Connector: connectors };
    }
    if (Object.keys(properties).length > 0) {
      physicalDescriptions.Properties = properties;
    }
    return physicalDescriptions;
  }

  /**
   * @returns {object} The xmlbuilder object for <Models>: the fixture's and the pixels' bounding boxes, if known.
   */
  _getModels() {
    const physical = this.fixture.physical;
    const models = [];

    // OFL dimensions are width, height, depth; GDTF models are length (x), width (y), height (z)
    const addModel = (name, [width, height, depth]) => {
      models.push({
        '@Name': name,
        '@Length': width / 1000,
        '@Width': depth / 1000,
        '@Height': height / 1000,
        '@PrimitiveType': 'Undefined',
      });
      return name;
    };

    if (physical?.dimensions) {
      this.bodyModel = addModel('Body', physical.dimensions);
    }
    if (physical?.matrixPixelsDimensions && this.fixture.matrix) {
      this.pixelModel = addModel('Pixel', physical.matrixPixelsDimensions);
    }

    return models.length > 0 ? { Model: models } : {};
  }

  /**
   * @returns {object} The xmlbuilder object for <Geometries>.
   */
  _getGeometries() {
    const layout = this.layout;
    const geometries = {};
    const addTopLevel = (type, xml) => {
      geometries[type] ??= [];
      geometries[type].push(xml);
    };

    for (const skeleton of layout.templateSkeletons.values()) {
      addTopLevel(skeleton.root.type, this._getGeometryXml(skeleton.root, (node) => layout.getNodeName(node, null), () => []));
    }

    for (const variant of layout.variants) {
      const getExtraChildren = (node) => (node === layout.mainSkeleton.inner ? this._getVariantExtras(variant) : []);
      addTopLevel('Geometry', this._getGeometryXml(layout.mainSkeleton.root, (node) => layout.getNodeName(node, variant), getExtraChildren));
    }

    return geometries;
  }

  /**
   * @param {Variant} variant - A geometry tree variant.
   * @returns {{ type: string, xml: object }[]} Geometry references or explicit pixel geometries of this variant.
   */
  _getVariantExtras(variant) {
    const layout = this.layout;
    const extras = [];

    for (const [templateGeometryKey, instances] of variant.references) {
      const templateRoot = layout.templateSkeletons.get(templateGeometryKey).root;
      for (const [pixelKey, breakOffset] of instances) {
        const reference = {
          '@Name': variant.referenceNames.get(`${templateGeometryKey}|${pixelKey}`),
          '@Geometry': layout.getNodeName(templateRoot, variant),
        };
        const position = this._getPixelPosition(pixelKey);
        if (position) {
          reference['@Position'] = position;
        }
        reference.Break = { '@DMXOffset': breakOffset, '@DMXBreak': 1 };
        extras.push({ type: 'GeometryReference', xml: reference });
      }
    }

    for (const pixelKey of variant.explicitPixelKeys) {
      const root = layout.explicitSkeletons.get(pixelKey).root;
      const xml = this._getGeometryXml(root, (node) => layout.getNodeName(node, variant), () => []);
      const position = this._getPixelPosition(pixelKey);
      if (position) {
        xml['@Position'] = position;
      }
      extras.push({ type: root.type, xml });
    }

    return extras;
  }

  /**
   * @param {GeometryNode} node - The geometry node.
   * @param {(node: GeometryNode) => string} getName - Returns the node's name in the current tree.
   * @param {(node: GeometryNode) => { type: string, xml: object }[]} getExtraChildren - Additional children per node.
   * @returns {object} The xmlbuilder object of the node (without the tag name).
   */
  _getGeometryXml(node, getName, getExtraChildren) {
    const xml = { '@Name': getName(node) };

    if (node.kind === 'main' && this.bodyModel) {
      xml['@Model'] = this.bodyModel;
    }
    else if (node.kind === 'pixel' && this.pixelModel) {
      xml['@Model'] = this.pixelModel;
    }

    if (node.type === 'Beam') {
      Object.assign(xml, this._getBeamAttributes(node));
    }

    const children = [
      ...node.children.map((child) => ({ type: child.type, xml: this._getGeometryXml(child, getName, getExtraChildren) })),
      ...getExtraChildren(node),
    ];
    for (const { type, xml: childXml } of children) {
      xml[type] ??= [];
      xml[type].push(childXml);
    }

    return xml;
  }

  /**
   * @param {GeometryNode} node - A beam node.
   * @returns {object} Beam XML attributes known from OFL's physical data.
   */
  _getBeamAttributes(node) {
    const physical = this.fixture.physical;
    if (!physical) {
      return {};
    }

    const attributes = {};
    const lampType = getLampType(physical.bulbType);
    if (lampType) {
      attributes['@LampType'] = lampType;
    }

    // the following describe the fixture's single light output, not individual pixels
    if (!node.isMainBeam) {
      return attributes;
    }

    if (physical.bulbLumens !== null) {
      attributes['@LuminousFlux'] = physical.bulbLumens;
    }
    if (physical.bulbColorTemperature !== null) {
      attributes['@ColorTemperature'] = physical.bulbColorTemperature;
    }
    if (physical.lensDegreesMin !== null && physical.lensDegreesMin === physical.lensDegreesMax) {
      attributes['@BeamAngle'] = physical.lensDegreesMin;
    }
    return attributes;
  }

  /**
   * @param {string} pixelKey - A pixel or pixel group key.
   * @returns {string | null} The GDTF position matrix of the pixel, if pixel dimensions and spacing are known.
   */
  _getPixelPosition(pixelKey) {
    const matrix = this.fixture.matrix;
    const dimensions = this.fixture.physical?.matrixPixelsDimensions;
    const spacing = this.fixture.physical?.matrixPixelsSpacing;
    const position = matrix.pixelKeyPositions[pixelKey];
    if (!dimensions || !spacing || !position) {
      return null;
    }

    // OFL's spacing is the gap between two pixels, so the distance between pixel centers is size + gap
    const pitches = dimensions.map((size, axis) => size + spacing[axis]);
    const counts = [matrix.pixelCountX, matrix.pixelCountY, matrix.pixelCountZ];
    const hasUnknownPitch = (axis) => !Number.isFinite(pitches[axis]) || pitches[axis] <= 0;
    if (counts.some((count, axis) => count > 1 && hasUnknownPitch(axis))) {
      return null;
    }

    // centered grid; OFL's y axis goes downwards and its z axis away from the viewer
    const [x, y, z] = position.map(
      (index, axis) => (counts[axis] > 1 ? (index - ((counts[axis] + 1) / 2)) * pitches[axis] / 1000 : 0),
    );
    return getPositionMatrix(x, -y, -z);
  }

  /**
   * @returns {object} The xmlbuilder object for <Revisions>.
   */
  _getRevisions() {
    const meta = this.fixture.meta;
    const modifiedBy = meta.authors.join(', ');
    const pluginVersion = this.options.displayedPluginVersion ?? version;

    const revisions = [{
      '@Text': `Created in Open Fixture Library: ${this.fixture.url}`,
      '@Date': formatDate(meta.createDate),
      '@ModifiedBy': modifiedBy,
    }];
    if (meta.lastModifyDate.getTime() !== meta.createDate.getTime()) {
      revisions.push({
        '@Text': 'Last modified in Open Fixture Library',
        '@Date': formatDate(meta.lastModifyDate),
        '@ModifiedBy': modifiedBy,
      });
    }
    revisions.at(-1)['@Text'] += ` (exported with GDTF export plugin ${pluginVersion})`;

    return { Revision: revisions };
  }

  /**
   * @returns {object} The xmlbuilder object for <Protocols>.
   */
  _getProtocols() {
    const rdm = this.fixture.rdm;
    if (!rdm) {
      return {};
    }

    const ftRdm = {};
    const manufacturerRdmId = this.fixture.manufacturer.rdmId;
    if (manufacturerRdmId !== null && manufacturerRdmId !== undefined) {
      ftRdm['@ManufacturerID'] = toHex(manufacturerRdmId);
    }
    ftRdm['@DeviceModelID'] = toHex(rdm.modelId);

    // GDTF lists DMX personalities per software version, which must be a hexadecimal number
    const softwareVersion = parseHexVersion(rdm.softwareVersion);
    if (softwareVersion !== null) {
      ftRdm.SoftwareVersionID = {
        '@Value': softwareVersion,
        'DMXPersonality': this.fixture.modes
          .filter((mode) => mode.rdmPersonalityIndex !== null)
          .map((mode) => ({
            '@Value': toHex(mode.rdmPersonalityIndex),
            '@DMXMode': sanitizeName(mode.name),
          })),
      };
    }

    return { FTRDM: ftRdm };
  }
}

/**
 * Groups consecutive set data that can share one GDTF channel function.
 * @param {object[]} setDataList - Set data of the specs of one switch target (or of a normal channel).
 * @returns {object[][]} Groups of set data.
 */
function groupFunctionSpecs(setDataList) {
  const groups = [];
  for (const setData of setDataList) {
    const previous = groups.at(-1)?.at(-1);
    const canJoin = previous
      && previous.spec.info.attribute === setData.spec.info.attribute
      && previous.spec.info.wheel === setData.spec.info.wheel
      && previous.spec.info.isColorMacro === setData.spec.info.isColorMacro
      && previous.spec.sourceChannel === setData.spec.sourceChannel
      && (previous.physical === null) === (setData.physical === null);

    if (canJoin) {
      groups.at(-1).push(setData);
    }
    else {
      groups.push([setData]);
    }
  }
  return groups;
}

/**
 * @param {{ startColors: string[], isStep: boolean } | null} colors - A capability's colors.
 * @returns {string | null} The color, if the capability has exactly one color.
 */
function getSingleColor(colors) {
  return colors?.isStep && colors.startColors.length === 1 ? colors.startColors[0] : null;
}

/**
 * @param {string} hexColor - A #rrggbb sRGB color.
 * @returns {string} The color in GDTF's CIE 1931 xyY format.
 */
function getCieColor(hexColor) {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hexColor.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const x = (0.4124 * red) + (0.3576 * green) + (0.1805 * blue);
  const y = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  const z = (0.0193 * red) + (0.1192 * green) + (0.9505 * blue);
  const sum = x + y + z;

  // black has no chromaticity, use the D65 white point
  const chromaticity = sum > 0 ? [x / sum, y / sum] : [0.3127, 0.329];
  return [...chromaticity, y * 100].map((value) => value.toFixed(6)).join(',');
}

/**
 * @param {Buffer} data - PNG file data.
 * @returns {{ width: number, height: number } | null} The image size, or null if the data is not a PNG image.
 */
function getPngSize(data) {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return data.length < 24 || !data.subarray(0, 8).equals(pngSignature) ? null : { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/**
 * @param {string | null} bulbType - OFL bulb type.
 * @returns {string | null} The GDTF lamp type, if it can be derived.
 */
function getLampType(bulbType) {
  if (!bulbType) {
    return null;
  }
  const lampTypes = [
    [/\bLEDs?\b/i, 'LED'],
    [/halogen/i, 'Halogen'],
    [/tungsten|incandescent/i, 'Tungsten'],
    [/discharge|\bHMI\b|\bMSD\b|\bMSR\b|\bHID\b|\bCDM\b|metal.?halide|xenon/i, 'Discharge'],
  ];
  return lampTypes.find(([regex]) => regex.test(bulbType))?.[1] ?? null;
}

/**
 * @param {number} x - X translation in meters.
 * @param {number} y - Y translation in meters.
 * @param {number} z - Z translation in meters.
 * @returns {string} A GDTF 4x4 transformation matrix without rotation.
 */
function getPositionMatrix(x, y, z) {
  const format = (value) => (Object.is(value, -0) ? 0 : value).toFixed(6);
  return `{1.000000,0.000000,0.000000,${format(x)}}{0.000000,1.000000,0.000000,${format(y)}}{0.000000,0.000000,1.000000,${format(z)}}{0.000000,0.000000,0.000000,1.000000}`;
}

/**
 * @param {Fixture} fixture - The fixture.
 * @returns {string} A name-based UUID that is stable for this fixture's OFL URL.
 */
function getFixtureTypeId(fixture) {
  const bytes = [...createHash('sha256').update(fixture.url).digest().subarray(0, 16)];
  bytes[6] = 0x50 + (bytes[6] % 16); // version 5 layout
  bytes[8] = 0x80 + (bytes[8] % 64); // RFC 4122 variant
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * @param {Date} date - A date.
 * @returns {string} The date in GDTF's format (yyyy-mm-ddThh:mm:ss).
 */
function formatDate(date) {
  return date.toISOString().replace(/\.\d+Z$/, '');
}

/**
 * @param {number} number - A non-negative integer.
 * @returns {string} The number in GDTF's hex format.
 */
function toHex(number) {
  return `0x${number.toString(16).toUpperCase()}`;
}

/**
 * @param {string | undefined} softwareVersion - OFL's RDM software version.
 * @returns {string | null} The GDTF software version ID, or null if the version is not a hexadecimal number.
 */
function parseHexVersion(softwareVersion) {
  const match = softwareVersion?.match(/^(?:0x)?([\dA-Fa-f]+)$/);
  return match ? `0x${match[1].toUpperCase()}` : null;
}

/**
 * @param {string} name - A manufacturer, fixture or resource name.
 * @returns {string} A string safe for file names.
 */
function sanitizeFileName(name) {
  return name.replaceAll(/[^\w\- ]+/g, '').trim().replaceAll(' ', '_');
}
