import JSZip from 'jszip';
import xml2js from 'xml2js';
import importJson from '../../lib/import-json.js';
import CoarseChannel from '../../lib/model/CoarseChannel.js';
import Matrix from '../../lib/model/Matrix.js';
import TemplateChannel from '../../lib/model/TemplateChannel.js';
import { scaleDmxRangeIndividually, scaleDmxValue } from '../../lib/scale-dmx-values.js';
import gdtfAttributes, { gdtfUnits } from './gdtf-attributes.js';
import { followXmlNodeReference, getRgbColorFromGdtfColor } from './gdtf-helpers.js';

export const version = '0.3.0';

/**
 * @typedef {object} Relation
 * @property {number} modeIndex The zero-based index of the mode this relation applies to.
 * @property {object} masterGdtfChannel The GDTF channel that triggers switching.
 * @property {string} switchingChannelName The name of the switching channel (containing multiple default channels).
 * @property {object} followerGdtfChannel The GDTF channel that is switched by the master.
 * @property {[number, Resolution]} dmxFrom The DMX value and DMX resolution of the start of the DMX range triggering this relation.
 * @property {[number, Resolution]} dmxTo The DMX value and DMX resolution of the end of the DMX range triggering this relation.
 */

/**
 * @param {Buffer} buffer - The imported file.
 * @param {string} filename - The imported file's name.
 * @param {string} authorName - The importer's name.
 * @returns {Promise<object, Error>} A Promise resolving to an out object
 */
export async function importFixtures(buffer, filename, authorName) {
  const fixture = {
    $schema: 'https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json',
  };

  const warnings = [];

  const xml = await getGdtfXml(buffer, filename);

  const gdtfFixture = xml.GDTF.FixtureType[0];
  fixture.name = gdtfFixture.$.Name;
  fixture.shortName = gdtfFixture.$.ShortName;

  const manufacturerKey = slugify(gdtfFixture.$.Manufacturer);
  const fixtureKey = `${manufacturerKey}/${slugify(fixture.name)}`;

  const manufacturers = await importJson('../../fixtures/manufacturers.json', import.meta.url);

  let manufacturer;
  if (manufacturerKey in manufacturers) {
    manufacturer = manufacturers[manufacturerKey];
  }
  else {
    manufacturer = {
      name: gdtfFixture.$.Manufacturer,
    };
    warnings.push('Please add manufacturer URL.');
  }

  fixture.categories = ['Other']; // TODO: can we find out categories?
  warnings.push('Please add fixture categories.');

  const timestamp = new Date().toISOString().replace(/T.*/, '');
  const [createDate, lastModifyDate] = getRevisionDates();

  fixture.meta = {
    authors: [authorName],
    createDate: getIsoDateFromGdtfDate(createDate, timestamp),
    lastModifyDate: getIsoDateFromGdtfDate(lastModifyDate, timestamp),
    importPlugin: {
      plugin: 'gdtf',
      date: timestamp,
      comment: `GDTF v${xml.GDTF.$.DataVersion} fixture type ID: ${gdtfFixture.$.FixtureTypeID}`,
    },
  };

  fixture.comment = getFixtureComment();

  warnings.push('Please add relevant links to the fixture.');

  addRdmInfo();

  warnings.push('Please add physical data to the fixture.');

  fixture.matrix = {};

  /** @type {Map<string, string>} OFL template channel keys (including `$pixelKey`) by the keys of GDTF channels with DMXBreak="Overwrite". */
  const templateKeysByChannelKey = new Map();

  addWheels();

  autoGenerateGdtfNameAttributes();
  const switchingChannelRelations = splitSwitchingChannels();

  addChannels();
  addModes();

  linkSwitchingChannels();

  cleanUpFixture(fixture, warnings);

  return {
    manufacturers: {
      [manufacturerKey]: manufacturer,
    },
    fixtures: {
      [fixtureKey]: fixture,
    },
    warnings: {
      [fixtureKey]: warnings,
    },
  };

  /**
   * @returns {[string | undefined, string | undefined]} An array with the earliest and latest revision dates of the GDTF fixture, if they are defined in <Revision> tag.
   */
  function getRevisionDates() {
    if (!gdtfFixture.Revisions?.[0]?.Revision) {
      return [undefined, undefined];
    }

    const revisions = gdtfFixture.Revisions[0].Revision;
    const earliestRevision = revisions[0];
    const latestRevision = revisions.at(-1);

    return [earliestRevision.$.Date, latestRevision.$.Date];
  }

  /**
   * @returns {string | undefined} The comment to add to the fixture.
   */
  function getFixtureComment() {
    const { Name, LongName, Manufacturer, Description } = gdtfFixture.$;

    const includeLongName = (LongName && LongName !== Name);
    const includeDescription = (Description && Description !== `${Manufacturer} ${Name}`);

    if (includeLongName && includeDescription) {
      return `${LongName}: ${Description}`;
    }

    if (includeLongName) {
      return LongName;
    }

    return includeDescription ? Description : undefined;
  }

  /**
   * Adds an RDM section to the OFL fixture and manufacturer if applicable.
   */
  function addRdmInfo() {
    if (!('Protocols' in gdtfFixture) || gdtfFixture.Protocols[0] === '' || !('FTRDM' in gdtfFixture.Protocols[0] || 'RDM' in gdtfFixture.Protocols[0])) {
      return;
    }

    const rdmData = (gdtfFixture.Protocols[0].FTRDM || gdtfFixture.Protocols[0].RDM)[0];
    const softwareVersion = getLatestSoftwareVersion();

    manufacturer.rdmId = Number.parseInt(rdmData.$.ManufacturerID, 16);
    fixture.rdm = {
      modelId: Number.parseInt(rdmData.$.DeviceModelID, 16),
      softwareVersion: softwareVersion.name,
    };

    const personalities = softwareVersion.personalities ?? [];
    for (const personality of personalities) {
      const index = Number.parseInt(personality.$.Value.replace('0x', ''), 16);
      const mode = followXmlNodeReference(gdtfFixture.DMXModes[0].DMXMode, personality.$.DMXMode);
      mode._oflRdmPersonalityIndex = index;
    }

    /**
     * @returns {object} Name and DMX personalities of the latest RDM software version (both may be undefined).
     */
    function getLatestSoftwareVersion() {
      let maxSoftwareVersion = undefined;

      const softwareVersions = rdmData.SoftwareVersionID || [];
      for (const rdmVersion of softwareVersions) {
        if (!maxSoftwareVersion || rdmVersion.$.Value > maxSoftwareVersion.$.Value) {
          maxSoftwareVersion = rdmVersion;
        }
      }

      if (maxSoftwareVersion) {
        return {
          name: maxSoftwareVersion.$.Value,
          personalities: maxSoftwareVersion.DMXPersonality,
        };
      }

      return {
        name: rdmData.$.SoftwareVersionID,
        personalities: [],
      };
    }
  }

  /**
   * Adds wheels to the OFL fixture (if there are any).
   */
  function addWheels() {
    if (!('Wheels' in gdtfFixture)) {
      return;
    }

    const virtualWheelNames = getVirtualColorMacroWheelNames();
    const gdtfWheels = (gdtfFixture.Wheels[0].Wheel || []).filter(
      (wheel) => wheel.$.Name !== 'ColorMacro' && !virtualWheelNames.has(wheel.$.Name),
    );

    if (gdtfWheels.length === 0) {
      return;
    }

    fixture.wheels = {};

    const wheelSlotTypes = getWheelSlotTypesFromUsage();

    for (const gdtfWheel of gdtfWheels) {
      fixture.wheels[gdtfWheel.$.Name] = {
        slots: (gdtfWheel.Slot || []).map((gdtfSlot) => {
          const name = gdtfSlot.$.Name;

          const slot = {
            type: 'Unknown',
          };

          if (name === 'Open') {
            slot.type = 'Open';
          }
          else if (name === 'Closed') {
            slot.type = 'Closed';
          }
          else if ('Color' in gdtfSlot.$) {
            slot.type = 'Color';
            slot.name = name;
            slot.colors = [getRgbColorFromGdtfColor(gdtfSlot.$.Color)];
          }
          else if ('Facet' in gdtfSlot) {
            slot.type = 'Prism';
            slot.name = name;
            slot.facets = gdtfSlot.Facet.length;
          }
          else if ('MediaFileName' in gdtfSlot.$ || name.startsWith('Gobo') || gdtfWheel.$.Name.startsWith('Gobo')) {
            slot.type = 'Gobo';
            slot.name = name;
          }
          else {
            slot.type = wheelSlotTypes.get(gdtfWheel.$.Name) ?? 'Unknown';

            // Iris and Frost slots don't have names in OFL
            if (slot.type !== 'Iris' && slot.type !== 'Frost') {
              slot.name = name;
            }
          }

          return slot;
        }),
      };
    }
  }

  /**
   * The attributes of the channel functions that use a wheel tell what kind of slots it has.
   * @returns {Map<string, string>} OFL wheel slot types by GDTF wheel name.
   */
  function getWheelSlotTypesFromUsage() {
    const slotTypesByAttribute = [
      [/^Color\d+/, 'Color'],
      [/^(?:Gobo|AnimationWheel)\d+/, 'Gobo'],
      [/^Prism\d+/, 'Prism'],
      [/^Frost\d+/, 'Frost'],
      [/^Iris/, 'Iris'],
    ];

    const wheelSlotTypes = new Map();
    for (const { $ } of getAllGdtfChannelFunctions()) {
      const slotType = slotTypesByAttribute.find(([regex]) => regex.test($.Attribute))?.[1];
      if (slotType && $.Wheel && !wheelSlotTypes.has($.Wheel)) {
        wheelSlotTypes.set($.Wheel, slotType);
      }
    }

    return wheelSlotTypes;
  }

  /**
   * Color macros can reference a virtual color wheel to describe their colors.
   * Such wheels are only used by ColorMacro(n) channel functions.
   * @returns {Set<string>} Names of wheels that are only referenced by color macro channel functions.
   */
  function getVirtualColorMacroWheelNames() {
    const wheelUsages = getAllGdtfChannelFunctions().filter(({ $ }) => $.Wheel);
    const isColorMacro = ({ $ }) => /^ColorMacro\d+$/.test($.Attribute);

    const colorMacroWheelNames = new Set(wheelUsages.filter((usage) => isColorMacro(usage)).map(({ $ }) => $.Wheel));
    const otherWheelNames = new Set(wheelUsages.filter((usage) => !isColorMacro(usage)).map(({ $ }) => $.Wheel));
    return colorMacroWheelNames.difference(otherWheelNames);
  }

  /**
   * @returns {object[]} All <ChannelFunction> XML objects of all modes.
   */
  function getAllGdtfChannelFunctions() {
    return gdtfFixture.DMXModes[0].DMXMode.flatMap(
      (gdtfMode) => gdtfMode.DMXChannels[0].DMXChannel.flatMap(
        (gdtfChannel) => gdtfChannel.LogicalChannel.flatMap(
          (gdtfLogicalChannel) => gdtfLogicalChannel.ChannelFunction ?? [],
        ),
      ),
    );
  }

  /**
   * Autmatically generates `Name` attributes for GDTF's `<DMXChannel>`,
   * `<LogicalChannel>` and `<ChannelFunction>` elements if they are not
   * already defined.
   */
  function autoGenerateGdtfNameAttributes() {
    const gdtfModes = gdtfFixture.DMXModes[0].DMXMode;
    for (const gdtfMode of gdtfModes) {
      // add default Name attributes, so that the references work later
      const gdtfChannels = gdtfMode.DMXChannels[0].DMXChannel;
      for (const gdtfChannel of gdtfChannels) {
        // auto-generate <DMXChannel> Name attribute
        const geometry = gdtfChannel.$.Geometry.split('.').pop();
        gdtfChannel.$.Name = `${geometry}_${gdtfChannel.LogicalChannel[0].$.Attribute}`;

        for (const gdtfLogicalChannel of gdtfChannel.LogicalChannel) {
          // auto-generate <LogicalChannel> Name attribute
          gdtfLogicalChannel.$.Name = gdtfLogicalChannel.$.Attribute;

          for (const [channelFunctionIndex, gdtfChannelFunction] of gdtfLogicalChannel.ChannelFunction.entries()) {
            // auto-generate <ChannelFunction> Name attribute if not already defined
            if (!('Name' in gdtfChannelFunction.$)) {
              gdtfChannelFunction.$.Name = `${gdtfChannelFunction.$.Attribute} ${channelFunctionIndex + 1}`;
            }
          }
        }
      }
    }
  }

  /**
   * @returns {Relation[]} An array of relations.
   */
  function splitSwitchingChannels() {
    const modeMasterRelations = splitModeMasterChannels();
    if (modeMasterRelations.length > 0) {
      return modeMasterRelations;
    }

    const relations = getLegacyRelations();

    for (const relation of relations) {
      const followerChannel = relation.followerGdtfChannel;

      // if channel was already split, skip splitting it again, else
      // split channel such that followerChannelFunction is the only child
      if (followerChannel.LogicalChannel[0].ChannelFunction.length > 1) {
        const channelCopy = structuredClone(followerChannel);
        channelCopy.$.Name += '_OflSplit';
        relation.followerGdtfChannel = channelCopy;

        // remove followerChannelFunction from followerChannel and all others from the copy
        const channelFunctionIndex = followerChannel.LogicalChannel[0].ChannelFunction.indexOf(relation.followerChannelFunction);
        followerChannel.LogicalChannel[0].ChannelFunction.splice(channelFunctionIndex, 1);
        channelCopy.LogicalChannel[0].ChannelFunction = [
          channelCopy.LogicalChannel[0].ChannelFunction[channelFunctionIndex],
        ];

        // insert channelCopy before the followerChannel
        const gdtfMode = gdtfFixture.DMXModes[0].DMXMode[relation.modeIndex];
        const channelIndex = gdtfMode.DMXChannels[0].DMXChannel.indexOf(followerChannel);
        gdtfMode.DMXChannels[0].DMXChannel.splice(channelIndex, 0, channelCopy);
      }

      delete relation.followerChannelFunction;
    }

    return relations;

    /**
     * Parses <ChannelFunction ModeMaster="…">'s relation data (added in GDTF v0.88)
     * and splits each DMX channel with such channel functions into one channel per
     * switch target: All channel functions that are active for the same ModeMaster
     * condition form one switch target. Conditions with identical channel functions
     * share a switch target. Channel functions without ModeMaster are always active,
     * so they are part of every switch target.
     * @returns {Relation[]} An array of relations, may be empty.
     */
    function splitModeMasterChannels() {
      const switchTargetRelations = [];
      const hasModeMasterFunction = (gdtfChannel) => gdtfChannel.LogicalChannel[0].ChannelFunction.some(({ $ }) => 'ModeMaster' in $);

      const gdtfModes = gdtfFixture.DMXModes[0].DMXMode;
      for (const [modeIndex, gdtfMode] of gdtfModes.entries()) {
        const gdtfChannels = gdtfMode.DMXChannels[0].DMXChannel;
        const channelsWithModeMaster = gdtfChannels.filter((gdtfChannel) => hasModeMasterFunction(gdtfChannel));

        for (const gdtfChannel of channelsWithModeMaster) {
          const switchTargets = getSwitchTargets(gdtfChannel.LogicalChannel[0].ChannelFunction);
          const followerChannels = splitChannel(gdtfChannels, gdtfChannel, switchTargets);

          for (const [targetIndex, { conditions }] of switchTargets.entries()) {
            for (const condition of conditions) {
              switchTargetRelations.push(createModeMasterRelation(modeIndex, gdtfChannel, followerChannels[targetIndex], condition));
            }
          }
        }
      }

      return switchTargetRelations;
    }

    /**
     * @param {number} modeIndex - The index of the mode.
     * @param {object} gdtfChannel - The original <DMXChannel> XML object, whose name is used for the switching channel.
     * @param {object} followerChannel - The <DMXChannel> XML object of the switch target.
     * @param {string[]} condition - ModeMaster, ModeFrom and ModeTo of the switch target's channel functions.
     * @returns {Relation} The relation.
     */
    function createModeMasterRelation(modeIndex, gdtfChannel, followerChannel, [modeMaster, modeFrom, modeTo]) {
      const gdtfMode = gdtfFixture.DMXModes[0].DMXMode[modeIndex];
      const dmxFrom = getDmxValueWithResolutionFromGdtfDmxValue(modeFrom, 0);
      const maxDmxValue = Math.pow(256, dmxFrom[1]) - 1;
      const dmxTo = getDmxValueWithResolutionFromGdtfDmxValue(modeTo, maxDmxValue, dmxFrom[1]);

      return {
        modeIndex,
        masterGdtfChannel: followXmlNodeReference(gdtfMode.DMXChannels[0], modeMaster.split('.', 1)[0]),
        switchingChannelName: gdtfChannel.$.Name,
        followerGdtfChannel: followerChannel,
        dmxFrom,
        dmxTo,
      };
    }

    /**
     * @param {object[]} gdtfChannelFunctions - The <ChannelFunction> XML objects of a DMX channel.
     * @returns {{ functions: object[], conditions: string[][] }[]} The switch targets, each with its channel functions and the ModeMaster conditions (master, from, to) that activate it.
     */
    function getSwitchTargets(gdtfChannelFunctions) {
      const alwaysActiveFunctions = gdtfChannelFunctions.filter(({ $ }) => !('ModeMaster' in $));
      const functionsPerCondition = Map.groupBy(
        gdtfChannelFunctions.filter(({ $ }) => 'ModeMaster' in $),
        ({ $ }) => JSON.stringify([$.ModeMaster, $.ModeFrom, $.ModeTo]),
      );

      // switch targets by the content of their channel functions
      const switchTargets = new Map();
      for (const [condition, conditionFunctions] of functionsPerCondition) {
        const targetFunctions = [...conditionFunctions, ...alwaysActiveFunctions];
        const contentKey = getChannelFunctionsContentKey(targetFunctions);

        if (!switchTargets.has(contentKey)) {
          switchTargets.set(contentKey, { functions: targetFunctions, conditions: [] });
        }
        switchTargets.get(contentKey).conditions.push(JSON.parse(condition));
      }

      return switchTargets.values().toArray();
    }

    /**
     * @param {object[]} gdtfChannelFunctions - <ChannelFunction> XML objects.
     * @returns {string} A key that is equal for channel functions with the same content, ignoring their names (often auto-numbered) and ModeMaster conditions.
     */
    function getChannelFunctionsContentKey(gdtfChannelFunctions) {
      const ignoredAttributes = new Set(['Name', 'ModeMaster', 'ModeFrom', 'ModeTo']);
      return JSON.stringify(gdtfChannelFunctions.map(({ $, ...children }) => ({
        attributes: Object.entries($).filter(([attribute]) => !ignoredAttributes.has(attribute)),
        children,
      })));
    }

    /**
     * Replaces a DMX channel by one copy per switch target, each containing only that target's channel functions.
     * @param {object[]} gdtfChannels - All <DMXChannel> XML objects of the mode; copies are inserted after the original.
     * @param {object} gdtfChannel - The <DMXChannel> XML object to split.
     * @param {{ functions: object[] }[]} switchTargets - The switch targets.
     * @returns {object[]} The <DMXChannel> XML objects of the switch targets (the first one is the original channel).
     */
    function splitChannel(gdtfChannels, gdtfChannel, switchTargets) {
      const channelIndex = gdtfChannels.indexOf(gdtfChannel);
      const followerChannels = switchTargets.map(({ functions }, targetIndex) => {
        if (targetIndex === 0) {
          gdtfChannel.LogicalChannel[0].ChannelFunction = functions;
          return gdtfChannel;
        }

        const channelCopy = structuredClone(gdtfChannel);
        channelCopy.$.Name += `_OflSplit${targetIndex}`;
        channelCopy.LogicalChannel[0].ChannelFunction = structuredClone(functions);
        return channelCopy;
      });

      gdtfChannels.splice(channelIndex + 1, 0, ...followerChannels.slice(1));
      return followerChannels;
    }

    /**
     * Parses <Relation Type="Mode">'s relation data.
     * This behavior is deprecated since GDTF v0.88, but still supported as a fallback.
     * @returns {Relation[]} An array of relations, may be empty.
     */
    function getLegacyRelations() {
      return gdtfFixture.DMXModes[0].DMXMode.flatMap((gdtfMode, modeIndex) => {
        if (!('Relations' in gdtfMode) || typeof gdtfMode.Relations[0] !== 'object') {
          return [];
        }

        return gdtfMode.Relations[0].Relation.flatMap((gdtfRelation) => {
          if (gdtfRelation.$.Type !== 'Mode') {
            return [];
          }

          const masterChannel = followXmlNodeReference(gdtfMode.DMXChannels[0], gdtfRelation.$.Master);

          // Slave was renamed to Follower in GDTF v0.88
          const followerChannelReference = gdtfRelation.$.Follower || gdtfRelation.$.Slave;
          const followerChannel = followXmlNodeReference(gdtfMode.DMXChannels[0], followerChannelReference.split('.', 1)[0]);
          const followerChannelFunction = followXmlNodeReference(gdtfMode.DMXChannels[0], followerChannelReference);

          const dmxFrom = getDmxValueWithResolutionFromGdtfDmxValue(gdtfRelation.$.DMXFrom, 0);
          const maxDmxValue = Math.pow(256, dmxFrom[1]) - 1;
          const dmxTo = getDmxValueWithResolutionFromGdtfDmxValue(gdtfRelation.$.DMXTo, maxDmxValue, dmxFrom[1]);

          return {
            modeIndex,
            masterGdtfChannel: masterChannel,
            switchingChannelName: followerChannel.$.Name,
            followerGdtfChannel: followerChannel,
            followerChannelFunction,
            dmxFrom,
            dmxTo,
          };
        });
      });
    }
  }

  /**
   * @typedef {object} ChannelWrapper
   * @property {string} key The channel key.
   * @property {object} channel The OFL channel object.
   * @property {number} maxResolution The highest used resolution of this channel.
   * @property {number[]} modeIndices The indices of the modes that this channel is used in.
   */

  /**
   * Add availableChannels and templateChannels to the fixture.
   */
  function addChannels() {
    const availableChannels = [];
    const templateChannels = [];

    const gdtfModes = gdtfFixture.DMXModes[0].DMXMode;
    for (const gdtfMode of gdtfModes) {
      const gdtfChannels = gdtfMode.DMXChannels[0].DMXChannel;
      for (const gdtfChannel of gdtfChannels) {
        addChannel(
          gdtfChannel.$.DMXBreak === 'Overwrite' ? templateChannels : availableChannels,
          gdtfChannel,
        );
      }
    }

    // append $pixelKey to templateChannels' keys and names, making sure that
    // resolved matrix channel keys can't be confused with available channel keys
    const availableChannelKeys = availableChannels.map((channelWrapper) => channelWrapper.key);
    for (const channelWrapper of templateChannels) {
      const baseKey = channelWrapper.key;
      const templateBaseKey = getUniqueTemplateBaseKey(baseKey, availableChannelKeys);

      channelWrapper.key = `${templateBaseKey} $pixelKey`;
      templateKeysByChannelKey.set(baseKey, channelWrapper.key);
      if (channelWrapper.channel.name === baseKey) {
        channelWrapper.channel.name = templateBaseKey;
      }
      channelWrapper.channel.name += ' $pixelKey';
    }

    cleanUpChannelWrappers([...availableChannels, ...templateChannels]);

    // convert availableChannels array to object and add it to fixture
    if (availableChannels.length > 0) {
      fixture.availableChannels = Object.fromEntries(
        availableChannels.map((channelWrapper) => [channelWrapper.key, channelWrapper.channel]),
      );
    }

    // convert templateChannels array to object and add it to fixture
    if (templateChannels.length > 0) {
      fixture.templateChannels = Object.fromEntries(
        templateChannels.map((channelWrapper) => [channelWrapper.key, channelWrapper.channel]),
      );
    }
  }

  /**
   * @param {string} baseKey - The desired base key of a template channel (without `$pixelKey`).
   * @param {string[]} availableChannelKeys - Keys of all available channels.
   * @returns {string} A base key whose resolved matrix channel keys (`<baseKey> <pixelKey>`) can't be confused with an available channel key.
   */
  function getUniqueTemplateBaseKey(baseKey, availableChannelKeys) {
    const isConfusable = (templateBaseKey) => availableChannelKeys.some(
      (key) => key === templateBaseKey || key.startsWith(`${templateBaseKey} `),
    );

    let templateBaseKey = baseKey;
    let index = 1;
    while (isConfusable(templateBaseKey)) {
      templateBaseKey = index === 1 ? `${baseKey} Pixel` : `${baseKey} Pixel ${index}`;
      index++;
    }
    return templateBaseKey;
  }

  /**
   * @param {ChannelWrapper[]} channelWrappers - The OFL availableChannels or templateChannels object.
   * @param {object} gdtfChannel - The GDTF <DMXChannel> XML object.
   */
  function addChannel(channelWrappers, gdtfChannel) {
    const name = getChannelName();

    if (gdtfChannel.LogicalChannel.length > 1) {
      warnings.push(`DMXChannel '${name}' has more than one LogicalChannel. This is not supported yet and could lead to undesired results.`);
    }

    const modeIndex = gdtfFixture.DMXModes[0].DMXMode.findIndex(
      (gdtfMode) => gdtfMode.DMXChannels[0].DMXChannel.includes(gdtfChannel),
    );

    const channel = {
      name,
      fineChannelAliases: [],
      dmxValueResolution: '',
      defaultValue: getChannelDefaultValue(),
    };

    if ('Highlight' in gdtfChannel.$ && gdtfChannel.$.Highlight !== 'None') {
      channel.highlightValue = getDmxValueWithResolutionFromGdtfDmxValue(gdtfChannel.$.Highlight);
    }

    const capabilities = getCapabilities();

    if (capabilities.length === 1) {
      channel.capability = capabilities[0];
      delete channel.capability.dmxRange;
    }
    else {
      channel.capabilities = capabilities;
    }

    replaceGdtfDmxValuesWithNumbers();

    // check if we already added the same channel in another mode
    const sameChannel = channelWrappers.find(
      (channelWrapper) => JSON.stringify(channelWrapper.channel) === JSON.stringify(channel) && !channelWrapper.modeIndices.includes(modeIndex),
    );
    if (sameChannel) {
      gdtfChannel._oflChannelKey = sameChannel.key;

      sameChannel.maxResolution = Math.max(sameChannel.maxResolution, getChannelResolution());
      sameChannel.modeIndices.push(modeIndex);
      return;
    }

    const channelKey = getChannelKey();

    gdtfChannel._oflChannelKey = channelKey;
    channelWrappers.push({
      key: channelKey,
      channel,
      maxResolution: getChannelResolution(),
      modeIndices: [modeIndex],
    });

    /**
     * Since GDTF v1.1, default values are defined per channel function and the
     * DMX channel's default value is the one of its initial channel function.
     * @returns {[number, Resolution] | null} The channel's default value, or null if it's zero or not defined.
     */
    function getChannelDefaultValue() {
      if ('Default' in gdtfChannel.$) {
        return getDmxValueWithResolutionFromGdtfDmxValue(gdtfChannel.$.Default);
      }

      const gdtfChannelFunctions = gdtfChannel.LogicalChannel.flatMap(
        (gdtfLogicalChannel) => gdtfLogicalChannel.ChannelFunction ?? [],
      );
      const initialFunctionName = gdtfChannel.$.InitialFunction?.split('.').at(-1);
      const initialFunction = gdtfChannelFunctions.find(
        (gdtfChannelFunction) => gdtfChannelFunction.$.Name === initialFunctionName,
      ) ?? gdtfChannelFunctions[0];

      if (!initialFunction || !('Default' in initialFunction.$)) {
        return null;
      }

      const defaultValue = getDmxValueWithResolutionFromGdtfDmxValue(initialFunction.$.Default);
      return defaultValue[0] === 0 ? null : defaultValue;
    }

    /**
     * @returns {string} The channel name.
     */
    function getChannelName() {
      const channelAttribute = gdtfChannel.LogicalChannel[0].$.Attribute;

      try {
        return gdtfFixture.AttributeDefinitions[0].Attributes[0].Attribute.find(
          (attribute) => attribute.$.Name === channelAttribute,
        ).$.Pretty || channelAttribute;
      }
      catch {
        return channelAttribute;
      }
    }

    /**
     * @returns {object[]} Array of OFL capability objects (but with GDTF DMX values).
     */
    function getCapabilities() {
      // save all <ChannelSet> XML nodes in a flat list
      const gdtfCapabilities = gdtfChannel.LogicalChannel.flatMap((gdtfLogicalChannel) => {
        if (!gdtfLogicalChannel.ChannelFunction) {
          throw new Error(`LogicalChannel does not contain any ChannelFunction children in DMXChannel ${JSON.stringify(gdtfChannel, null, 2)}`);
        }

        return gdtfLogicalChannel.ChannelFunction.flatMap((gdtfChannelFunction) => {
          if (!gdtfChannelFunction.ChannelSet) {
            // add an empty <ChannelSet />
            gdtfChannelFunction.ChannelSet = [{ $: {} }];
          }

          // GDTF: a channel set's DMX start and physical range default to its
          // channel function's (and a function's physical range defaults to 0…1)
          const channelFunctionPhysicalFrom = parseFloatWithFallback(gdtfChannelFunction.$.PhysicalFrom, 0);
          const channelFunctionPhysicalTo = parseFloatWithFallback(gdtfChannelFunction.$.PhysicalTo, 1);

          // save GDTF attribute for later
          gdtfChannelFunction._attribute = followXmlNodeReference(
            gdtfFixture.AttributeDefinitions[0].Attributes[0],
            gdtfChannelFunction.$.Attribute,
          ) || { $: { Name: 'NoFeature' } };

          // the physical range of each channel function is used to guess the unit of unitless attributes
          gdtfChannelFunction._minPhysicalValue = Infinity;
          gdtfChannelFunction._maxPhysicalValue = -Infinity;

          return gdtfChannelFunction.ChannelSet.map((gdtfChannelSet) => {
            // save parent nodes for future use
            gdtfChannelSet._logicalChannel = gdtfLogicalChannel;
            gdtfChannelSet._channelFunction = gdtfChannelFunction;
            gdtfChannelSet._fixture = gdtfFixture;

            // do some preprocessing

            if (!('$' in gdtfChannelSet)) {
              gdtfChannelSet.$ = {};
            }

            if (!('Name' in gdtfChannelSet.$)) {
              gdtfChannelSet.$.Name = '';
            }

            if (!('DMXFrom' in gdtfChannelSet.$)) {
              gdtfChannelSet.$.DMXFrom = gdtfChannelFunction.$.DMXFrom;
            }

            gdtfChannelSet._dmxFrom = getDmxValueWithResolutionFromGdtfDmxValue(gdtfChannelSet.$.DMXFrom, 0);

            const channelSetPhysicalFrom = parseFloatWithFallback(gdtfChannelSet.$.PhysicalFrom, channelFunctionPhysicalFrom);
            const channelSetPhysicalTo = parseFloatWithFallback(gdtfChannelSet.$.PhysicalTo, channelFunctionPhysicalTo);

            gdtfChannelSet._physicalFrom = channelSetPhysicalFrom;
            gdtfChannelSet._physicalTo = channelSetPhysicalTo;
            gdtfChannelSet._hasExplicitPhysicalValues = [gdtfChannelSet.$, gdtfChannelFunction.$].some(
              (attributes) => 'PhysicalFrom' in attributes || 'PhysicalTo' in attributes,
            );

            gdtfChannelFunction._minPhysicalValue = Math.min(gdtfChannelFunction._minPhysicalValue, channelSetPhysicalFrom, channelSetPhysicalTo);
            gdtfChannelFunction._maxPhysicalValue = Math.max(gdtfChannelFunction._maxPhysicalValue, channelSetPhysicalFrom, channelSetPhysicalTo);

            return gdtfChannelSet;
          });
        });
      });

      // Collapse a channel whose ChannelSets are a fully-redundant
      // (Closed, …, Open) / (Open, …, Closed) wrapping of a single full-range
      // Intensity / ColorIntensity capability into one synthesized ChannelSet.
      const collapseTarget = getCollapseTarget();
      const collapsedGdtfCapabilities = collapseTarget !== null && isCollapseTargetMatchedByAllChannelSets(collapseTarget)
        ? [createCollapsedChannelSet()]
        : gdtfCapabilities;

      return collapsedGdtfCapabilities.map((gdtfCapability, index) => {
        const capability = {
          dmxRange: [gdtfCapability._dmxFrom, getDmxRangeEnd(index)],
        };

        const gdtfAttribute = gdtfCapability._channelFunction._attribute;
        const attributeName = gdtfAttribute.$.Name;
        const capabilityTypeData = getCapabilityTypeData(attributeName);

        capability.type = capabilityTypeData.oflType;

        callHook(capabilityTypeData.beforePhysicalPropertyHook, capability, gdtfCapability, attributeName);

        const oflProperty = getOflProperty(capabilityTypeData, gdtfCapability);

        const physicalFrom = gdtfCapability._physicalFrom;
        const physicalTo = gdtfCapability._physicalTo;

        // e.g. slot numbers can't be determined without a WheelSlotIndex
        const hasPhysicalValues = !Number.isNaN(physicalFrom) && !Number.isNaN(physicalTo);

        if (oflProperty !== null && hasPhysicalValues) {
          const physicalUnit = getPhysicalUnit(gdtfCapability);

          if (physicalFrom === physicalTo) {
            capability[oflProperty] = physicalUnit(physicalFrom, null);
          }
          else {
            capability[`${oflProperty}Start`] = physicalUnit(physicalFrom, physicalTo);
            capability[`${oflProperty}End`] = physicalUnit(physicalTo, physicalFrom);

            if (capability.brightnessStart === '0%' && capability.brightnessEnd === '100%') {
              delete capability.brightnessStart;
              delete capability.brightnessEnd;
            }
          }
        }

        callHook(capabilityTypeData.afterPhysicalPropertyHook, capability, gdtfCapability, attributeName);

        if (gdtfCapability.$.Name) {
          capability.comment = gdtfCapability.$.Name;
        }

        return capability;
      });

      /**
       * @returns {object | null} The shared properties that every ChannelSet of
       * this channel must match for the channel to collapse into a single
       * full-range Intensity / ColorIntensity capability, or null if collapse
       * is not applicable.
       */
      function getCollapseTarget() {
        if (gdtfCapabilities.length < 2) {
          return null;
        }

        const channelFunction = gdtfCapabilities[0]._channelFunction;
        const oflType = getCapabilityTypeData(channelFunction._attribute.$.Name).oflType;
        if (oflType !== 'Intensity' && oflType !== 'ColorIntensity') {
          return null;
        }

        const closedNames = new Set(['Closed', 'closed', 'Min', 'min']);
        const openNames = new Set(['Open', 'open', 'Max', 'max']);

        const { _physicalFrom: physicalFrom, _physicalTo: physicalTo } = gdtfCapabilities[0];
        if (physicalFrom === 0 && physicalTo === 1) {
          return { channelFunction, physicalFrom, physicalTo, lowEndNames: closedNames, highEndNames: openNames };
        }
        return physicalFrom === 1 && physicalTo === 0
          ? { channelFunction, physicalFrom, physicalTo, lowEndNames: openNames, highEndNames: closedNames }
          : null;
      }

      /**
       * @param {object} target - The shared properties returned by `getCollapseTarget`.
       * @returns {boolean} Whether every ChannelSet matches the target's shared
       * properties and has a Name consistent with its position in the channel.
       */
      function isCollapseTargetMatchedByAllChannelSets(target) {
        const firstName = gdtfCapabilities[0].$.Name;
        const lastName = gdtfCapabilities.at(-1).$.Name;
        const middleHasName = gdtfCapabilities.slice(1, -1).some((capability) => capability.$.Name !== '');

        return !middleHasName
          && (firstName === '' || target.lowEndNames.has(firstName))
          && (lastName === '' || target.highEndNames.has(lastName))
          && gdtfCapabilities.every((capability) =>
            capability._channelFunction === target.channelFunction
            && capability._physicalFrom === target.physicalFrom
            && capability._physicalTo === target.physicalTo,
          );
      }

      /**
       * @returns {object} A synthesized ChannelSet that replaces all of
       * `gdtfCapabilities` after a successful collapse check, copying the
       * first ChannelSet's parent references and physical values but with an
       * empty Name. The downstream `.map(...)` then turns this into a single
       * OFL capability covering the channel's full DMX range.
       */
      function createCollapsedChannelSet() {
        const firstCapability = gdtfCapabilities[0];
        return {
          $: { Name: '' },
          _logicalChannel: firstCapability._logicalChannel,
          _channelFunction: firstCapability._channelFunction,
          _fixture: firstCapability._fixture,
          _dmxFrom: firstCapability._dmxFrom,
          _physicalFrom: firstCapability._physicalFrom,
          _physicalTo: firstCapability._physicalTo,
          _hasExplicitPhysicalValues: firstCapability._hasExplicitPhysicalValues,
        };
      }

      /**
       * @param {number} index - The index of the capability.
       * @returns {[number, Resolution]} The GDTF DMX value for this capability's range end.
       */
      function getDmxRangeEnd(index) {
        const dmxFrom = collapsedGdtfCapabilities[index]._dmxFrom;

        if (index === collapsedGdtfCapabilities.length - 1) {
          // last capability
          const resolution = dmxFrom[1];
          return [Math.pow(256, resolution) - 1, resolution];
        }

        const [nextDmxFromValue, resolution] = collapsedGdtfCapabilities[index + 1]._dmxFrom;
        return [nextDmxFromValue - 1, resolution];
      }

      /**
       * @param {string} attributeName - The GDTF attribute name.
       * @returns {object} The capability type data from `gdtf-attributes.js`
       */
      function getCapabilityTypeData(attributeName) {
        let capabilityTypeData = gdtfAttributes[attributeName];

        if (!capabilityTypeData) {
          const enumeratedAttributeName = attributeName.replace(/\d+/, '(n)').replace(/\d+/, '(m)');
          capabilityTypeData = gdtfAttributes[enumeratedAttributeName];
        }

        if (!capabilityTypeData) {
          return {
            oflType: `Unknown (${attributeName})`, // will trigger an error in the validation
            oflProperty: 'physical', // will also trigger an error, but the information could be useful
          };
        }

        if (!capabilityTypeData.inheritFrom) {
          return capabilityTypeData;
        }

        // save the inherited result for later access
        gdtfAttributes[attributeName] = {

          ...getCapabilityTypeData(capabilityTypeData.inheritFrom),
          ...capabilityTypeData,
        };
        delete gdtfAttributes[attributeName].inheritFrom;

        return gdtfAttributes[attributeName];
      }

      /**
       * @param {((...args: unknown[]) => unknown) | null} hook - The hook function, or a falsy value.
       * @param {unknown[]} parameters - The arguments to pass to the hook.
       * @returns {unknown} The return value of the hook, or null if no hook was called.
       */
      function callHook(hook, ...parameters) {
        return hook ? hook(...parameters) : null;
      }

      /**
       * @param {object} capabilityTypeData - The capability type data from `gdtf-attributes.js`
       * @param {object} gdtfCapability - The enhanced <ChannelSet> XML object.
       * @returns {string | null} The OFL property name, or null.
       */
      function getOflProperty(capabilityTypeData, gdtfCapability) {
        if (!('oflProperty' in capabilityTypeData)) {
          return null;
        }

        return typeof capabilityTypeData.oflProperty === 'function'
          ? capabilityTypeData.oflProperty(gdtfCapability)
          : capabilityTypeData.oflProperty;
      }

      /**
       * @param {object} gdtfCapability - The enhanced <ChannelSet> XML object.
       * @returns {(value: number, otherValue?: number) => string} The function to turn a physical value into an entity string with the correct unit.
       */
      function getPhysicalUnit(gdtfCapability) {
        const gdtfAttribute = gdtfCapability._channelFunction._attribute;
        const capabilityTypeData = getCapabilityTypeData(gdtfAttribute.$.Name);

        // slot numbers are always unitless
        if (capabilityTypeData.oflProperty === 'index' || capabilityTypeData.oflProperty === 'slotNumber') {
          return gdtfUnits.None;
        }

        let physicalEntity = gdtfAttribute.$.PhysicalUnit;

        // "None" is the default value of the PhysicalUnit attribute, so treat it like a missing attribute
        if (!physicalEntity || physicalEntity.toLowerCase() === 'none') {
          physicalEntity = 'None';

          const { _minPhysicalValue: minPhysicalValue, _maxPhysicalValue: maxPhysicalValue } = gdtfCapability._channelFunction;

          // unitless physical values between 0 and 1 are relative, and so is
          // GDTF's default range 0…1 if no physical values are given
          if (!gdtfCapability._hasExplicitPhysicalValues || (minPhysicalValue >= 0 && maxPhysicalValue <= 1)) {
            physicalEntity = 'Percent';
          }
          else if (capabilityTypeData.defaultPhysicalEntity) {
            physicalEntity = capabilityTypeData.defaultPhysicalEntity;
          }
        }
        else if (!(physicalEntity in gdtfUnits)) {
          // ignore case of PhysicalUnit attribute
          physicalEntity = Object.keys(gdtfUnits).find(
            (entity) => entity.toLowerCase() === physicalEntity.toLowerCase(),
          );
        }

        return gdtfUnits[physicalEntity];
      }
    }

    /**
     * @returns {number} The resolution of this channel.
     */
    function getChannelResolution() {
      // The Offset attribute replaced the Coarse/Fine/Ultra/Uber attributes in GDTF v1.0
      if ('Offset' in gdtfChannel.$) {
        return gdtfChannel.$.Offset.split(',').length;
      }

      if (hasNonNoneAttribute(gdtfChannel, 'Uber')) {
        return 4;
      }

      if (hasNonNoneAttribute(gdtfChannel, 'Ultra')) {
        return 3;
      }

      return hasNonNoneAttribute(gdtfChannel, 'Fine') ? 2 : 1;
    }

    /**
     * @returns {string} The channel key, derived from the name and made unique.
     */
    function getChannelKey() {
      let key = name;

      // make unique by appending ' 2', ' 3', ... if necessary
      let duplicates = 1;
      const doesChannelKeyExist = () => channelWrappers.some((channelWrapper) => channelWrapper.key === key);
      while (doesChannelKeyExist()) {
        duplicates++;
        key = `${name} ${duplicates}`;
      }

      return key;
    }

    /**
     * Look through all GDTF DMX values in this channel (consisting of DMX value
     * and the resolution in which it is specified), make their resolution equal and
     * replace them with a number. Then set the channel's dmxValueResolution to
     * this resolution.
     */
    function replaceGdtfDmxValuesWithNumbers() {
      const maxDmxValueResolution = getMaxDmxValueResolution();
      const scaleToResolution = Math.max(CoarseChannel.RESOLUTION_8BIT, maxDmxValueResolution);

      if (channel.defaultValue) {
        channel.defaultValue = scaleDmxValue(...channel.defaultValue, scaleToResolution);
      }

      if (channel.highlightValue) {
        channel.highlightValue = scaleDmxValue(...channel.highlightValue, scaleToResolution);
      }

      if (channel.capabilities) {
        for (const capability of channel.capabilities) {
          const startValue = capability.dmxRange[0][0];
          const startResolution = capability.dmxRange[0][1];
          const endValue = capability.dmxRange[1][0];
          const endResolution = capability.dmxRange[1][1];

          try {
            capability.dmxRange = scaleDmxRangeIndividually(startValue, startResolution, endValue, endResolution, scaleToResolution);
          }
          catch {
            // will be caught by validation
            capability.dmxRange = [startValue, endValue];
          }
        }
      }

      if (maxDmxValueResolution !== 0) {
        channel.dmxValueResolution = `${maxDmxValueResolution * 8}bit`;
      }

      /**
       * @returns {number} The highest DMX value resolution used in this channel, or 0 if no DMX value is used at all.
       */
      function getMaxDmxValueResolution() {
        const dmxValues = [];

        if (channel.defaultValue && channel.defaultValue[0] !== 0) {
          dmxValues.push(channel.defaultValue);
        }

        if (channel.highlightValue && channel.highlightValue[0] !== 0) {
          dmxValues.push(channel.highlightValue);
        }

        if (channel.capabilities) {
          for (const capability of channel.capabilities) {
            dmxValues.push(capability.dmxRange[0], capability.dmxRange[1]);
          }
        }

        return Math.max(0, ...dmxValues.map(
          ([value, resolution]) => resolution,
        ));
      }
    }
  }

  /**
   * @typedef {object} MatrixChannelReference
   * @property {string} templateKey The OFL template channel key (including `$pixelKey`).
   * @property {string} pixelKey The OFL pixel key.
   */

  /**
   * Add modes and matrix pixel keys (if needed) to the fixture.
   *
   * DMX channels with `DMXBreak="Overwrite"` belong to a geometry that is
   * instantiated by <GeometryReference> nodes in the mode's geometry tree.
   * Each instance is a matrix pixel whose channels are at the DMX address
   * `<Break DMXOffset>` + `Offset` - 1.
   */
  function addModes() {
    /** @type {Map<string, number[]>} All matrix pixels that are used in some mode, with their position. */
    const matrixPixels = new Map();

    const topLevelGeometryNames = getTopLevelGeometryNames();

    fixture.modes = gdtfFixture.DMXModes[0].DMXMode.map((gdtfMode) => {
      /** @type {(string | MatrixChannelReference | undefined)[]} */
      const channels = [];
      const geometryReferences = findGeometryReferences(gdtfMode.$.Geometry);
      const modeSpecificSuffix = getModeSpecificNameSuffix(gdtfMode.$.Geometry);

      const gdtfChannels = gdtfMode.DMXChannels[0].DMXChannel;
      for (const gdtfChannel of gdtfChannels) {
        if (gdtfChannel.$.DMXBreak === 'Overwrite') {
          addTemplateChannelInstances(channels, gdtfChannel, { gdtfMode, geometryReferences, modeSpecificSuffix });
        }
        else {
          addModeChannel(channels, gdtfChannel);
        }
      }

      return {
        name: gdtfMode.$.Name,
        rdmPersonalityIndex: gdtfMode._oflRdmPersonalityIndex,
        channels: getModeChannels(channels),
      };
    });

    if (matrixPixels.size === 1) {
      // OFL matrices need at least two pixels
      resolveSinglePixelMatrix(matrixPixels.keys().next().value);
      return;
    }

    fixture.matrix = {
      pixelKeys: getPixelKeyStructure(matrixPixels),
    };

    // try to simplify matrix channel insert blocks
    const pixelKeysInXyzOrder = JSON.stringify(new Matrix(fixture.matrix).getPixelKeysByOrder('X', 'Y', 'Z'));
    for (const mode of fixture.modes) {
      for (const channel of mode.channels) {
        if (typeof channel === 'object' && channel?.insert === 'matrixChannels'
          && pixelKeysInXyzOrder === JSON.stringify(channel.repeatFor)) {
          channel.repeatFor = 'eachPixelXYZ';
        }
      }
    }

    /**
     * @param {(string | MatrixChannelReference | undefined)[]} channels - The mode's channels by DMX address.
     * @param {object} gdtfChannel - A <DMXChannel> XML object without DMXBreak="Overwrite".
     */
    function addModeChannel(channels, gdtfChannel) {
      const channelKey = gdtfChannel._oflChannelKey;
      const channelKeys = [channelKey, ...(fixture.availableChannels[channelKey].fineChannelAliases ?? [])];
      for (const [index, offset] of getChannelOffsets(gdtfChannel)) {
        channels[offset - 1] = channelKeys[index];
      }
    }

    /**
     * Adds a matrix channel reference for every geometry reference that instantiates the channel's geometry.
     * @param {(string | MatrixChannelReference | undefined)[]} channels - The mode's channels by DMX address.
     * @param {object} gdtfChannel - A <DMXChannel> XML object with DMXBreak="Overwrite".
     * @param {object} context - The mode's context.
     * @param {object} context.gdtfMode - The <DMXMode> XML object.
     * @param {object[]} context.geometryReferences - All geometry references in the mode's geometry tree.
     * @param {string | null} context.modeSpecificSuffix - The suffix of names in the mode's geometry tree.
     */
    function addTemplateChannelInstances(channels, gdtfChannel, { gdtfMode, geometryReferences, modeSpecificSuffix }) {
      const templateKey = templateKeysByChannelKey.get(gdtfChannel._oflChannelKey);
      const templateKeys = [templateKey, ...(fixture.templateChannels[templateKey].fineChannelAliases ?? [])];
      const templateGeometryName = topLevelGeometryNames.get(gdtfChannel.$.Geometry) ?? gdtfChannel.$.Geometry;
      const references = geometryReferences.filter((reference) => reference.$.Geometry === templateGeometryName);

      if (references.length === 0) {
        warnings.push(`DMXChannel '${gdtfChannel.$.Name}' in mode '${gdtfMode.$.Name}' has DMXBreak="Overwrite", but its geometry '${templateGeometryName}' is not referenced in the mode's geometry tree.`);
      }

      const channelOffsets = getChannelOffsets(gdtfChannel);
      for (const [referenceIndex, reference] of references.entries()) {
        const pixelKey = getPixelKey(reference, modeSpecificSuffix) || `${templateGeometryName} ${referenceIndex + 1}`;
        if (!matrixPixels.has(pixelKey)) {
          matrixPixels.set(pixelKey, reference._translation);
        }

        const breakOffset = getOverwriteBreakOffset(reference);
        for (const [index, offset] of channelOffsets) {
          channels[breakOffset + offset - 2] = { templateKey: templateKeys[index], pixelKey };
        }
      }
    }

    /**
     * Exporters have to give each mode's geometry tree unique names, often by
     * appending a suffix to the names of another tree, like "Body (Mode 2)".
     * @param {string} rootGeometryName - The name of the mode's top-level geometry.
     * @returns {string | null} The suffix of the mode's geometry names, if its root is a renamed copy of another top-level geometry.
     */
    function getModeSpecificNameSuffix(rootGeometryName) {
      const match = /^(.+)( \([^()]+\))$/.exec(rootGeometryName);
      if (!match) {
        return null;
      }
      const isCopy = getChildGeometries(gdtfFixture.Geometries[0]).some((node) => node.$.Name === match[1]);
      return isCopy ? match[2] : null;
    }

    /**
     * @param {object} gdtfReference - A <GeometryReference> XML object.
     * @param {string | null} modeSpecificSuffix - The suffix of names in this mode's geometry tree.
     * @returns {string} The OFL pixel key, which is the same in all modes.
     */
    function getPixelKey(gdtfReference, modeSpecificSuffix) {
      const name = gdtfReference.$.Name ?? '';
      return modeSpecificSuffix && name !== modeSpecificSuffix && name.endsWith(modeSpecificSuffix)
        ? name.slice(0, -modeSpecificSuffix.length)
        : name;
    }

    /**
     * Arranges the pixels in a grid if their positions allow it, else in one row.
     * @param {Map<string, number[]>} pixels - Pixel keys with their (translation) position.
     * @returns {(string | null)[][][]} OFL's pixelKeys structure (z, y, x).
     */
    function getPixelKeyStructure(pixels) {
      const pixelKeys = pixels.keys().toArray();
      const positions = pixels.values().map((position) => position.map((value) => roundPosition(value))).toArray();
      const distinctPositions = new Set(positions.map((position) => position.join(',')));
      if (distinctPositions.size !== pixels.size) {
        // overlapping or missing positions
        return [[pixelKeys]];
      }

      // GDTF's y axis goes upwards and its z axis towards the viewer, OFL's the other way around
      const getAxisValues = (axis, compare) => new Set(positions.map((position) => position[axis])).values().toArray().toSorted(compare);
      const xValues = getAxisValues(0, (a, b) => a - b);
      const yValues = getAxisValues(1, (a, b) => b - a);
      const zValues = getAxisValues(2, (a, b) => b - a);

      const structure = createEmptyPixelKeyStructure(zValues.length, yValues.length, xValues.length);
      for (const [index, pixelKey] of pixelKeys.entries()) {
        const [x, y, z] = positions[index];
        structure[zValues.indexOf(z)][yValues.indexOf(y)][xValues.indexOf(x)] = pixelKey;
      }
      return structure;
    }

    /**
     * Replaces all template channels by normal channels for the only pixel.
     * @param {string} pixelKey - The pixel key.
     */
    function resolveSinglePixelMatrix(pixelKey) {
      const resolveKey = (templateKey) => TemplateChannel.resolveTemplateString(templateKey, { pixelKey });

      fixture.availableChannels ??= {};
      const templateChannels = Object.entries(fixture.templateChannels ?? {});
      for (const [templateKey, templateChannel] of templateChannels) {
        fixture.availableChannels[resolveKey(templateKey)] = TemplateChannel.resolveTemplateObject(templateChannel, { pixelKey });
      }
      for (const [channelKey, templateKey] of templateKeysByChannelKey) {
        templateKeysByChannelKey.set(channelKey, resolveKey(templateKey));
      }
      delete fixture.templateChannels;

      for (const mode of fixture.modes) {
        mode.channels = mode.channels.flatMap((channel) => (
          typeof channel === 'object' && channel?.insert === 'matrixChannels'
            ? channel.templateChannels.map((templateKey) => resolveKey(templateKey))
            : [channel]
        ));
      }
    }

    /**
     * @param {object} gdtfChannel - The GDTF <DMXChannel> XML object.
     * @returns {[number, number][]} Pairs of fineness index (0 = coarse) and one-based DMX offset.
     */
    function getChannelOffsets(gdtfChannel) {
      // The Offset attribute replaced the Coarse/Fine/Ultra/Uber attributes in GDTF v1.0
      const channelOffsets = hasNonNoneAttribute(gdtfChannel, 'Offset')
        ? gdtfChannel.$.Offset.split(',')
        : [
            gdtfChannel.$.Coarse,
            gdtfChannel.$.Fine,
            gdtfChannel.$.Ultra,
            gdtfChannel.$.Uber,
          ];

      return channelOffsets
        .map((channelOffset, index) => [index, Number.parseInt(channelOffset, 10)])
        .filter(([, dmxChannelNumber]) => !Number.isNaN(dmxChannelNumber));
    }

    /**
     * @param {object} gdtfReference - A <GeometryReference> XML object.
     * @returns {number} The DMX offset for channels with `DMXBreak="Overwrite"`, which is defined by the last <Break> child.
     */
    function getOverwriteBreakOffset(gdtfReference) {
      const dmxOffset = gdtfReference.Break?.at(-1)?.$?.DMXOffset ?? '1';

      // DMXAddress may be given as absolute address or as Universe.Address
      const [universeOrAddress, address] = dmxOffset.split('.').map((part) => Number.parseInt(part, 10));
      const offset = address === undefined ? universeOrAddress : ((universeOrAddress - 1) * 512) + address;
      return Number.isNaN(offset) ? 1 : offset;
    }

    /**
     * @returns {Map<string, string>} The name of the top-level geometry for every geometry name.
     */
    function getTopLevelGeometryNames() {
      const topLevelNames = new Map();

      const topLevelNodes = getChildGeometries(gdtfFixture.Geometries[0]);
      for (const topLevelNode of topLevelNodes) {
        traverseGeometries(topLevelNode, (node) => {
          topLevelNames.set(node.$.Name, topLevelNode.$.Name);
        });
      }

      return topLevelNames;
    }

    /**
     * Find all <GeometryReference> XML nodes in a mode's geometry tree. Each
     * gets a `_translation` property with its position relative to the root.
     * @param {string} rootGeometryName - The name of the mode's top-level geometry.
     * @returns {object[]} An array of all geometry reference XML objects.
     */
    function findGeometryReferences(rootGeometryName) {
      const topLevelNodes = getChildGeometries(gdtfFixture.Geometries[0]);
      const rootNode = topLevelNodes.find((node) => node.$.Name === rootGeometryName);

      // without a valid root geometry, fall back to all geometry trees
      const geometryReferences = [];
      const treeRoots = rootNode ? [rootNode] : topLevelNodes;
      for (const node of treeRoots) {
        traverseGeometries(node, (childNode, tagName) => {
          if (tagName === 'GeometryReference') {
            geometryReferences.push(childNode);
          }
        });
      }

      return geometryReferences;
    }

    /**
     * @param {object} xmlNode - A geometry XML node or the <Geometries> node.
     * @returns {object[]} All child geometry XML nodes, each with a `_tagName` property.
     */
    function getChildGeometries(xmlNode) {
      return Object.entries(xmlNode)
        .filter(([tagName, childNodes]) => tagName !== '$' && tagName !== 'Break' && Array.isArray(childNodes))
        .flatMap(([tagName, childNodes]) => childNodes
          .filter((childNode) => typeof childNode === 'object')
          .map((childNode) => {
            childNode._tagName = tagName;
            return childNode;
          }));
    }

    /**
     * Recursively calls the callback for the given geometry node and all its descendants.
     * Geometry references are not followed.
     * @param {object} xmlNode - The geometry XML node to start traversing at.
     * @param {(node: object, tagName: string) => void} callback - Called for every geometry node.
     * @param {number[]} [parentTranslation] - The translation of the parent node relative to the tree's root.
     */
    function traverseGeometries(xmlNode, callback, parentTranslation = [0, 0, 0]) {
      const translation = getTranslation(xmlNode.$?.Position).map((value, axis) => value + parentTranslation[axis]);
      xmlNode._translation = translation;

      callback(xmlNode, xmlNode._tagName);

      if (xmlNode._tagName === 'GeometryReference') {
        return;
      }

      for (const childNode of getChildGeometries(xmlNode)) {
        traverseGeometries(childNode, callback, translation);
      }
    }

    /**
     * @param {string | undefined} position - A GDTF position matrix like `{1,0,0,x}{0,1,0,y}{0,0,1,z}{0,0,0,1}`.
     * @returns {number[]} The translation part of the matrix (rotations are ignored).
     */
    function getTranslation(position) {
      const rows = position?.match(/\{[^}]*\}/g);
      return !rows || rows.length < 3 ? [0, 0, 0] : rows.slice(0, 3).map((row) => Number.parseFloat(row.slice(1, -1).split(',', 4)[3]) || 0);
    }

    /**
     * Turns a list of channel keys and matrix channel references (indexed by
     * DMX address) into OFL mode channels, using matrix channel insert blocks
     * wherever the matrix channels follow a regular pattern.
     * @param {(string | MatrixChannelReference | undefined)[]} channels - Channels by DMX address.
     * @returns {(string | null | object)[]} OFL mode channels.
     */
    function getModeChannels(channels) {
      const modeChannels = [];

      let index = 0;
      while (index < channels.length) {
        const channel = channels[index];

        if (!isMatrixChannelReference(channel)) {
          modeChannels.push(channel ?? null);
          index++;
          continue;
        }

        const block = getMatrixChannelInsertBlock(channels, index);
        if (block.length === 1) {
          modeChannels.push(TemplateChannel.resolveTemplateString(channel.templateKey, { pixelKey: channel.pixelKey }));
        }
        else {
          modeChannels.push({
            insert: 'matrixChannels',
            repeatFor: block.pixelKeys,
            channelOrder: block.channelOrder,
            templateChannels: block.templateKeys,
          });
        }
        index += block.length;
      }

      return modeChannels;
    }

    /**
     * @param {(string | MatrixChannelReference | undefined)[]} channels - Channels by DMX address.
     * @param {number} start - Index of the first matrix channel reference of the block.
     * @returns {{ length: number, pixelKeys: string[], templateKeys: string[], channelOrder: string }} The longest matrix channel insert block starting at the given index.
     */
    function getMatrixChannelInsertBlock(channels, start) {
      const perPixelBlock = getRegularBlock(channels, start, 'pixelKey', 'templateKey');
      const perChannelBlock = getRegularBlock(channels, start, 'templateKey', 'pixelKey');

      if (perChannelBlock.length > perPixelBlock.length) {
        return {
          length: perChannelBlock.length,
          pixelKeys: perChannelBlock.innerKeys,
          templateKeys: perChannelBlock.outerKeys,
          channelOrder: 'perChannel',
        };
      }

      return {
        length: perPixelBlock.length,
        pixelKeys: perPixelBlock.outerKeys,
        templateKeys: perPixelBlock.innerKeys,
        channelOrder: 'perPixel',
      };
    }

    /**
     * Finds the longest block of the form `outer1 × inner*, outer2 × inner*, …`,
     * e.g. for per-pixel order: all template channels of pixel 1, then the same template channels of pixel 2, …
     * @param {(string | MatrixChannelReference | undefined)[]} channels - Channels by DMX address.
     * @param {number} start - Index of the first matrix channel reference of the block.
     * @param {'pixelKey' | 'templateKey'} outerProperty - The property that changes slowly.
     * @param {'pixelKey' | 'templateKey'} innerProperty - The property that changes quickly.
     * @returns {{ length: number, outerKeys: string[], innerKeys: string[] }} The block.
     */
    function getRegularBlock(channels, start, outerProperty, innerProperty) {
      const firstOuterKey = channels[start][outerProperty];
      const innerKeys = [];
      let index = start;
      while (
        isMatrixChannelReference(channels[index])
        && channels[index][outerProperty] === firstOuterKey
        && !innerKeys.includes(channels[index][innerProperty])
      ) {
        innerKeys.push(channels[index][innerProperty]);
        index++;
      }

      const outerKeys = [firstOuterKey];
      for (;;) {
        // index-based access, as array methods skip the holes of the sparse channels array
        const nextChannels = [];
        for (let innerIndex = 0; innerIndex < innerKeys.length; innerIndex++) {
          nextChannels.push(channels[index + innerIndex]);
        }
        if (nextChannels.some((channel) => !isMatrixChannelReference(channel))) {
          break;
        }

        const outerKey = nextChannels[0][outerProperty];
        const isRepetition = !outerKeys.includes(outerKey) && nextChannels.every(
          (channel, innerIndex) => channel[outerProperty] === outerKey && channel[innerProperty] === innerKeys[innerIndex],
        );
        if (!isRepetition) {
          break;
        }

        outerKeys.push(outerKey);
        index += innerKeys.length;
      }

      return { length: index - start, outerKeys, innerKeys };
    }

    /**
     * @param {unknown} channel - An entry of the channels list.
     * @returns {boolean} Whether the entry is a matrix channel reference.
     */
    function isMatrixChannelReference(channel) {
      return typeof channel === 'object' && channel !== null;
    }
  }

  /**
   * Adds switchChannels property to all master channels' capabilities and use
   * the switching channel key in modes' channel lists.
   */
  function linkSwitchingChannels() {
    const { relationsPerMaster, modeChannelReplacements } = transformRelations(fixture, switchingChannelRelations);

    // switch channels in trigger channels' capabilities
    for (const triggerChannelKey of Object.keys(relationsPerMaster)) {
      const triggerChannelRelations = simplifySwitchingChannelRelations(triggerChannelKey);

      const triggerChannel = fixture.availableChannels?.[triggerChannelKey]
        ?? fixture.availableChannels?.[templateKeysByChannelKey.get(triggerChannelKey)]
        ?? fixture.templateChannels[templateKeysByChannelKey.get(triggerChannelKey)];

      if (triggerChannel.defaultValue === null) {
        triggerChannel.defaultValue = 0;
      }

      const channelResolution = getChannelResolution(triggerChannel);

      for (const capability of triggerChannel.capabilities) {
        capability.switchChannels = Object.fromEntries(Object.entries(triggerChannelRelations).flatMap(
          ([switchingChannelKey, relations]) => relations
            .filter((relation) => {
              const [dmxFrom, dmxTo] = scaleDmxRangeIndividually(...relation.dmxFrom, ...relation.dmxTo, channelResolution);
              return capability.dmxRange[0] >= dmxFrom && capability.dmxRange[1] <= dmxTo;
            })
            .map((relation) => [switchingChannelKey, relation.switchToChannelKey]),
        ));
      }
    }

    replaceSwitchingChannelsInModes(fixture, modeChannelReplacements);

    /**
     * @param {string} triggerChannelKey - Key of the trigger channel, whose relations should be simplified.
     * @returns {object} Simplified switching channel's relations.
     */
    function simplifySwitchingChannelRelations(triggerChannelKey) {
      const simplifiedRelations = {};

      const masterRelations = relationsPerMaster[triggerChannelKey];
      for (const [switchingChannelKey, relations] of Object.entries(masterRelations)) {
        // were this switching channel's relations already added?
        const addedSwitchingChannelKey = Object.keys(simplifiedRelations).find(
          (otherKey) => JSON.stringify(masterRelations[otherKey]) === JSON.stringify(relations),
        );

        if (addedSwitchingChannelKey) {
          // already added switching channel has the same relations, so we don't need to add it
          // but we need to update modeChannelReplacements
          for (const mode of Object.values(modeChannelReplacements)) {
            for (const channelKey of Object.keys(mode)) {
              if (mode[channelKey] === switchingChannelKey) {
                mode[channelKey] = addedSwitchingChannelKey;
              }
            }
          }
        }
        else {
          // add the new switching channel
          simplifiedRelations[switchingChannelKey] = relations;
        }
      }

      return simplifiedRelations;
    }

    /**
     * @param {CoarseChannel} channel - The OFL channel object.
     * @returns {number} The fineness of the channel.
     */
    function getChannelResolution(channel) {
      if ('dmxValueResolution' in channel) {
        // e.g. '16bit' -> 2
        return Number.parseInt(channel.dmxValueResolution, 10) / 8;
      }

      return 'fineChannelAliases' in channel
        ? channel.fineChannelAliases.length + 1
        : CoarseChannel.RESOLUTION_8BIT;
    }
  }
}

/**
 * @param {number} value - A position value in meters.
 * @returns {number} The value rounded to micrometers, to compare positions without floating point noise.
 */
function roundPosition(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * @param {number} depth - Number of pixels along the z axis.
 * @param {number} height - Number of pixels along the y axis.
 * @param {number} width - Number of pixels along the x axis.
 * @returns {null[][][]} A pixel key structure (z, y, x) without pixels.
 */
function createEmptyPixelKeyStructure(depth, height, width) {
  const createRow = () => Array.from({ length: width }, () => null);
  const createLayer = () => Array.from({ length: height }, createRow);
  return Array.from({ length: depth }, createLayer);
}

/**
 * @param {Buffer} buffer - The imported file.
 * @param {string} filename - The imported file's name.
 * @returns {Promise<object>} A Promise that resolves to the parsed XML object.
 */
async function getGdtfXml(buffer, filename) {
  let xmlString = buffer.toString();

  if (filename.endsWith('.gdtf')) {
    // unzip the .gdtf (zip) file and check its description.xml file
    const zip = await JSZip.loadAsync(buffer);

    const descriptionFile = zip.file('description.xml');
    if (descriptionFile === null) {
      throw new Error('The provided .gdtf (zip) file does not contain a \'description.xml\' file in the root directory.');
    }

    xmlString = await descriptionFile.async('string');
  }

  return xml2js.parseStringPromise(xmlString);
}

/**
 * Remove unnecessary `name` and `dmxValueResolution` properties and fill/remove
 * `fineChannelAliases`.
 * @param {ChannelWrapper[]} channelWrappers - The OFL availableChannels or templateChannels objects.
 */
function cleanUpChannelWrappers(channelWrappers) {
  for (const channelWrapper of channelWrappers) {
    const { key: channelKey, channel, maxResolution } = channelWrapper;

    if (channelKey === channel.name) {
      delete channel.name;
    }

    if (maxResolution === CoarseChannel.RESOLUTION_8BIT) {
      delete channel.fineChannelAliases;
    }
    else {
      // CoarseChannel.RESOLUTION_16BIT
      channel.fineChannelAliases.push(`${channelKey} fine`);

      for (let index = CoarseChannel.RESOLUTION_24BIT; index <= maxResolution; index++) {
        channel.fineChannelAliases.push(`${channelKey} fine^${index - 1}`);
      }
    }

    if (channel.dmxValueResolution === `${maxResolution * 8}bit` || channel.dmxValueResolution === '') {
      delete channel.dmxValueResolution;
    }
  }
}

/**
 * @typedef {object} SwitchToChannelInfo
 * @property {[number, Resolution]} dmxFrom The DMX value and DMX resolution of the start of the DMX range triggering this relation.
 * @property {[number, Resolution]} dmxTo The DMX value and DMX resolution of the end of the DMX range triggering this relation.
 * @property {string} switchToChannelKey The key of the channel to switch to.
 */

/**
 * @typedef {object} TransformedRelations
 * @property {Record<string, Record<string, SwitchToChannelInfo>>} relationsPerMaster An object mapping a master channel key and a switching channel key to the switch to channel information.
 * @property {ModeChannelReplacements} modeChannelReplacements An object mapping a mode index and a switch to channel key to the switching channel key.
 */

/**
 * @typedef {Record<number, Record<string, string>>} ModeChannelReplacements
 * An object mapping a mode index and a switch to channel key to the switching channel key.
 */

/**
 * Bring relations into a structure we can work with.
 * @param {object} fixture - The OFL fixture object.
 * @param {Relation[]} switchingChannelRelations - An array of relations.
 * @returns {TransformedRelations} The transformed relations.
 */
function transformRelations(fixture, switchingChannelRelations) {
  const relationsPerMaster = {};
  const modeChannelReplacements = {};

  /** @type {Map<string, string>} Coarse switching channel keys by fine switching channel key. */
  const coarseSwitchingChannelKeys = new Map();

  // bring relations into a structure we can work with
  for (const relation of switchingChannelRelations) {
    const masterKey = relation.masterGdtfChannel._oflChannelKey;

    if (!(masterKey in relationsPerMaster)) {
      relationsPerMaster[masterKey] = {};
    }

    const modeIndex = relation.modeIndex;
    const switchingChannelKey = `${modeIndex}_${relation.switchingChannelName}`;
    const switchToChannelKey = relation.followerGdtfChannel._oflChannelKey;

    if (!(switchingChannelKey in relationsPerMaster[masterKey])) {
      relationsPerMaster[masterKey][switchingChannelKey] = [];
    }

    relationsPerMaster[masterKey][switchingChannelKey].push({
      dmxFrom: relation.dmxFrom,
      dmxTo: relation.dmxTo,
      switchToChannelKey,
    });

    if (!modeChannelReplacements[modeIndex]) {
      modeChannelReplacements[modeIndex] = {};
    }

    modeChannelReplacements[modeIndex][switchToChannelKey] = switchingChannelKey;

    transformRelationFineChannels(relation, switchingChannelKey, switchToChannelKey);
  }

  removeIncompleteFineSwitchingChannels();

  return { relationsPerMaster, modeChannelReplacements };

  /**
   * If only some switch targets have fine channels, a fine switching channel
   * would not have a target for all trigger values. In that case, the fine
   * channel is kept as a normal channel in the mode; it is only meaningful while
   * its coarse channel is active.
   */
  function removeIncompleteFineSwitchingChannels() {
    for (const masterRelations of Object.values(relationsPerMaster)) {
      for (const [fineSwitchingChannelKey, coarseSwitchingChannelKey] of coarseSwitchingChannelKeys) {
        const fineRelations = masterRelations[fineSwitchingChannelKey];
        const coarseRelations = masterRelations[coarseSwitchingChannelKey];
        if (!fineRelations || !coarseRelations || fineRelations.length === coarseRelations.length) {
          continue;
        }

        delete masterRelations[fineSwitchingChannelKey];
        removeChannelReplacementsBy(fineSwitchingChannelKey);
      }
    }
  }

  /**
   * @param {string} switchingChannelKey - The key of a removed switching channel.
   */
  function removeChannelReplacementsBy(switchingChannelKey) {
    for (const channelReplacements of Object.values(modeChannelReplacements)) {
      for (const [switchToChannelKey, replacementChannelKey] of Object.entries(channelReplacements)) {
        if (replacementChannelKey === switchingChannelKey) {
          delete channelReplacements[switchToChannelKey];
        }
      }
    }
  }

  /**
   * Adds all implicit fine channel relations for a given relation.
   * @param {Relation} relation - The relation for the coarse channel.
   * @param {string} switchingChannelKey - The switching channel key of the coarse channel.
   * @param {string} switchToChannelKey - The switch to channel key of the coarse channel.
   */
  function transformRelationFineChannels(relation, switchingChannelKey, switchToChannelKey) {
    const masterKey = relation.masterGdtfChannel._oflChannelKey;
    const modeIndex = relation.modeIndex;

    const switchToChannel = fixture.availableChannels[switchToChannelKey];
    if (switchToChannel && 'fineChannelAliases' in switchToChannel) {
      for (const [fineness, fineChannelAlias] of switchToChannel.fineChannelAliases.entries()) {
        let switchingFineChannelKey = `${switchingChannelKey} fine`;
        if (fineness > 0) {
          switchingFineChannelKey += `^${fineness + 1}`;
        }

        if (!(switchingFineChannelKey in relationsPerMaster[masterKey])) {
          relationsPerMaster[masterKey][switchingFineChannelKey] = [];
        }
        coarseSwitchingChannelKeys.set(switchingFineChannelKey, switchingChannelKey);

        relationsPerMaster[masterKey][switchingFineChannelKey].push({
          dmxFrom: relation.dmxFrom,
          dmxTo: relation.dmxTo,
          switchToChannelKey: fineChannelAlias,
        });
        modeChannelReplacements[modeIndex][fineChannelAlias] = switchingFineChannelKey;
      }
    }
  }
}

/**
 * Replaces normal channels with switching channels in fixture's modes.
 * @param {object} fixture - The OFL fixture object.
 * @param {ModeChannelReplacements} modeChannelReplacements - An object mapping a mode index and a switch to channel key to the switching channel key.
 */
function replaceSwitchingChannelsInModes(fixture, modeChannelReplacements) {
  for (const [modeIndex, mode] of fixture.modes.entries()) {
    if (!(modeIndex in modeChannelReplacements)) {
      continue;
    }

    const channelReplacements = modeChannelReplacements[modeIndex];
    for (const [switchToChannelKey, replacementChannelKey] of Object.entries(channelReplacements)) {
      const channelIndex = mode.channels.indexOf(switchToChannelKey);

      if (channelIndex !== -1) {
        mode.channels[channelIndex] = replacementChannelKey;
      }
    }
  }
}

/**
 * Removes `defaultValue`s and fixture matrix if they're unneeded.
 * @param {object} fixture - The OFL fixture object.
 * @param {string[]} warnings - An array to add warnings to.
 */
function cleanUpFixture(fixture, warnings) {
  if ('availableChannels' in fixture) {
    for (const channel of Object.values(fixture.availableChannels)) {
      if (channel.defaultValue === null) {
        delete channel.defaultValue;
      }
    }
  }

  if ('templateChannels' in fixture) {
    warnings.push('Please fix the visual representation of the matrix.');

    for (const channel of Object.values(fixture.templateChannels)) {
      if (channel.defaultValue === null) {
        delete channel.defaultValue;
      }
    }
  }
  else {
    delete fixture.matrix;
  }
}

/**
 * @param {object} xmlNode - An XML node object.
 * @param {string} attribute - The attribute name to check.
 * @returns {boolean} True if the node has the attribute and its value is not "None", false otherwise.
 */
function hasNonNoneAttribute(xmlNode, attribute) {
  return attribute in xmlNode.$ && xmlNode.$[attribute] !== 'None';
}

/**
 * GDTF date strings are already in ISO format. Before GDTF v1.0, date strings had
 * the form "dd.MM.yyyy HH:mm:ss", so those have to be converted to the ISO format.
 *
 * @see https://gdtf-share.com/wiki/GDTF_File_Description#attrType-date
 * @param {string | undefined} dateString - An ISO date string or a date in the form "dd.MM.yyyy HH:mm:ss"
 * @param {string} fallbackDateString - A fallback date string to return if the parsed date is not valid.
 * @returns {string} A date string in the form "YYYY-MM-DD" (may be the provided fallback date string).
 */
function getIsoDateFromGdtfDate(dateString, fallbackDateString) {
  if (!dateString) {
    return fallbackDateString;
  }

  const isoDateMatch = dateString.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoDateMatch !== null) {
    return isoDateMatch[1];
  }

  const germanDateTimeRegex = /^([0-3]?\d)\.([01]?\d)\.(\d{4})\s+\d?\d:\d?\d:\d?\d$/;
  const match = dateString.match(germanDateTimeRegex);

  try {
    const [, day, month, year] = match;
    const date = new Date(Date.UTC(Number.parseInt(year, 10), Number.parseInt(month, 10) - 1, day));

    return date.toISOString().replace(/T.*/, '');
  }
  catch {
    return fallbackDateString;
  }
}

/**
 * @param {string | undefined} dmxValueString - GDTF DMX value in the form "128/2", see https://gdtf-share.com/wiki/GDTF_File_Description#attrType-DMXValue
 * @param {number | undefined} fallbackValue - DMX value that is used if `dmxValueString` is falsy.
 * @param {number} [fallbackResolution=1] - DMX value resolution that is used if `dmxValueString` is falsy.
 * @returns {[number, Resolution]} Array containing DMX value and DMX resolution.
 */
function getDmxValueWithResolutionFromGdtfDmxValue(dmxValueString, fallbackValue, fallbackResolution = 1) {
  if (!dmxValueString && fallbackValue !== undefined) {
    return [fallbackValue, fallbackResolution];
  }

  try {
    const [, value, resolution] = dmxValueString.match(/^(\d+)\/(\d)$/);
    return [Number.parseInt(value, 10), Number.parseInt(resolution, 10)];
  }
  catch {
    return [Number.parseInt(dmxValueString, 10) || 0, 1];
  }
}

/**
 * @param {string} value - The string to parse.
 * @param {number} fallback - The number to use if the string can't be parsed.
 * @returns {number} The parsed number.
 */
function parseFloatWithFallback(value, fallback) {
  const number = Number.parseFloat(value);
  return Number.isNaN(number) ? fallback : number;
}

/**
 * @param {string} string - The string to slugify.
 * @returns {string} A slugified version of the string, i.e. only containing lowercase letters, numbers and dashes.
 */
function slugify(string) {
  return string.toLowerCase().replaceAll(/[^\da-z-]+/g, ' ').trim().replaceAll(/\s+/g, '-');
}
