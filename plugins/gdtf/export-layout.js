/** @import ../../lib/model/Capability.js from '../../lib/model/Capability.js'; */
import CoarseChannel from '../../lib/model/CoarseChannel.js';
import FineChannel from '../../lib/model/FineChannel.js';
import NullChannel from '../../lib/model/NullChannel.js';
import SwitchingChannel from '../../lib/model/SwitchingChannel.js';
import { getFunctionInfo, getUniqueName, sanitizeName } from './export-capabilities.js';
/** @import AbstractChannel from '../../lib/model/AbstractChannel.js' */
/** @import Fixture from '../../lib/model/Fixture.js' */
/** @import Mode from '../../lib/model/Mode.js' */
/** @import Wheel from '../../lib/model/Wheel.js' */
/** @import { FunctionInfo, WheelInfo } from './export-capabilities.js' */

/**
 * A node in a GDTF geometry tree. Nodes are abstract: a node of the main
 * skeleton is written once per geometry tree variant, with different names.
 */
export class GeometryNode {
  /**
   * @param {'Geometry' | 'Axis' | 'Beam'} type - The GDTF geometry type.
   * @param {string} baseName - The name of the node, before it is made unique.
   */
  constructor(type, baseName) {
    this.type = type;
    this.baseName = baseName;
    /** @type {GeometryNode[]} */
    this.children = [];
    /** @type {Map<string, string>} Used DMX channel attributes, mapped to the assignment key that uses them. */
    this.usedAttributes = new Map();
    /** @type {Map<string, GeometryNode>} Child nodes created to resolve DMX channel name collisions, by assignment key. */
    this.collisionChildren = new Map();
    /** @type {'pixel' | 'group' | 'main' | null} */
    this.kind = null;
    /** @type {string | null} Model name. */
    this.model = null;
    /** @type {string | null} GDTF position matrix. */
    this.position = null;
    /** @type {boolean} Whether this node gets the fixture's beam properties. */
    this.isMainBeam = false;
  }

  /**
   * @param {GeometryNode} child - The child node.
   * @returns {GeometryNode} The child node.
   */
  addChild(child) {
    this.children.push(child);
    return child;
  }
}

/**
 * The geometry nodes a channel can be placed on, built for one geometry root.
 */
class Skeleton {
  /**
   * @param {object} options - Options.
   * @param {string} options.rootName - Name of the root node.
   * @param {string} options.prefix - Prefix for names of the other nodes.
   * @param {boolean} options.hasPan - Whether a pan axis is needed.
   * @param {boolean} options.hasTilt - Whether a tilt axis is needed.
   * @param {boolean} options.hasBeam - Whether a beam is needed.
   * @param {boolean} [options.rootIsBeam] - Whether the root node itself should be the beam if no axes are needed.
   */
  constructor({ rootName, prefix, hasPan, hasTilt, hasBeam, rootIsBeam = false }) {
    if (hasBeam && rootIsBeam && !hasPan && !hasTilt) {
      this.root = new GeometryNode('Beam', rootName);
      this.beam = this.root;
      this.pan = null;
      this.tilt = null;
      this.inner = this.root;
      return;
    }

    this.root = new GeometryNode('Geometry', rootName);
    let parent = this.root;
    this.pan = null;
    this.tilt = null;
    if (hasPan) {
      this.pan = parent.addChild(new GeometryNode('Axis', `${prefix}Yoke`));
      parent = this.pan;
    }
    if (hasTilt) {
      this.tilt = parent.addChild(new GeometryNode('Axis', `${prefix}Head`));
      parent = this.tilt;
    }
    this.inner = parent;
    this.beam = hasBeam ? parent.addChild(new GeometryNode('Beam', `${prefix}Beam`)) : null;
  }

  /**
   * @param {string} attribute - The main GDTF attribute of a DMX channel.
   * @returns {GeometryNode} The node the channel should be placed on.
   */
  getNodeForAttribute(attribute) {
    if (attribute === 'Pan' || attribute === 'PanRotate') {
      return this.pan ?? this.root;
    }
    if (attribute === 'Tilt' || attribute === 'TiltRotate') {
      return this.tilt ?? this.root;
    }
    if (attribute === 'PositionMSpeed') {
      return this.pan ?? this.tilt ?? this.root;
    }
    return this.beam ?? this.inner;
  }
}

/**
 * @typedef {object} FineSlot
 * @property {number} offset The one-based DMX channel offset of the fine channel.
 * @property {Set<string>} coarseKeys Keys of the coarse channels (switch targets) this fine channel belongs to.
 */

/**
 * @typedef {object} FunctionSpec
 * @property {FunctionInfo} info GDTF function info; its attribute may still contain `(n)`.
 * @property {$k$$k$$l$$k$$k$$l$lib$l$model$l$Capability$k$js | null} capability The OFL capability, or null for placeholder functions.
 * @property {AbstractChannel} sourceChannel The OFL channel the capability belongs to.
 * @property {string} placeholderName Name for placeholder functions without capability.
 * @property {AbstractChannel | null} switchTarget The switch target channel, if this function is only active for some trigger values.
 */

/**
 * One GDTF DMX channel: a coarse channel with its fine channels in a mode.
 */
export class Unit {
  /**
   * @param {AbstractChannel} main - The OFL coarse, switching, null or orphaned fine channel.
   * @param {number} offset - The one-based DMX offset of the main channel.
   */
  constructor(main, offset) {
    this.main = main;
    this.offset = offset;
    /** @type {FineSlot[]} */
    this.fineSlots = [];
    /** @type {string | null} */
    this.pixelKey = main.pixelKey ?? null;
    /** @type {string | null} Key of the template channel this unit is created from. */
    this.templateKey = null;
    /** @type {'main' | 'template' | 'instance' | 'explicit'} */
    this.role = 'main';
    /** @type {string | null} */
    this.templateGeometryKey = null;
    /** @type {Assignment | null} */
    this.assignment = null;
  }

  /**
   * @returns {number[]} All DMX offsets of this unit, from most to least significant.
   */
  get offsets() {
    return [this.offset, ...this.fineSlots.map((slot) => slot.offset)];
  }

  /**
   * @returns {number} The resolution of the GDTF DMX channel.
   */
  get resolution() {
    return 1 + this.fineSlots.length;
  }

  /**
   * @param {AbstractChannel} channel - The main channel or a switch target channel.
   * @returns {number} The resolution in which this channel's DMX values are written.
   */
  getResolutionFor(channel) {
    const fineCount = this.fineSlots.filter((slot) => slot.coarseKeys.has(channel.key)).length;
    const resolution = 1 + fineCount;
    return channel instanceof CoarseChannel ? Math.min(resolution, channel.maxResolution) : resolution;
  }

  /**
   * @returns {AbstractChannel[]} The channels whose capabilities are used in this unit.
   */
  get sourceChannels() {
    return this.main instanceof SwitchingChannel ? this.main.switchToChannels : [this.main];
  }
}

/**
 * @typedef {object} Assignment
 * @property {string} key Unique key of the assignment (the same OFL channel in the same geometry context gets the same assignment in every mode).
 * @property {GeometryNode} node The geometry node of the DMX channel.
 * @property {boolean} isTemplateNode Whether node belongs to a template (top-level referenced) geometry.
 * @property {string} logicalAttribute The concrete attribute of the logical channel.
 * @property {FunctionSpec[]} functions Function specs with concrete attributes.
 */

/**
 * @typedef {object} TemplateInstance
 * @property {string} pixelKey The OFL pixel or pixel group key.
 * @property {number} breakOffset The DMX offset of the GDTF geometry reference.
 */

/**
 * @typedef {object} TemplateClass
 * @property {string} templateGeometryKey Key of the template geometry.
 * @property {'pixel' | 'group'} kind Whether the instances are pixels or pixel groups.
 * @property {TemplateInstance[]} instances All instances, ordered by DMX address.
 * @property {Unit[]} definitionUnits The units of the first instance, which define the template's DMX channels.
 */

/**
 * @typedef {object} ModeLayout
 * @property {Mode} mode The OFL mode.
 * @property {Unit[]} units All units of the mode that result in a GDTF DMX channel, ordered by offset.
 * @property {TemplateClass[]} templateClasses Template classes used in this mode.
 * @property {Set<string>} explicitPixelKeys Pixel keys whose channels are written without geometry references.
 * @property {number} variantIndex Index of the geometry tree variant used by this mode.
 */

/**
 * @typedef {object} Variant
 * @property {number} index The variant index.
 * @property {string} label Label appended to node names in variants other than the first, referring to the first mode that uses the variant.
 * @property {Map<string, Map<string, number>>} references Break offsets per pixel key, per template geometry key.
 * @property {Set<string>} explicitPixelKeys Pixel keys that have explicit (non-referenced) geometries.
 * @property {Map<GeometryNode, string>} names Unique names of all nodes in this variant's tree.
 * @property {Map<string, string>} referenceNames Unique names of geometry references, by `${templateGeometryKey}|${pixelKey}`.
 */

/**
 * Computes how a fixture's modes map to GDTF DMX channels and geometries.
 */
export class Layout {
  /**
   * @param {Fixture} fixture - The fixture.
   * @param {Map<Wheel, WheelInfo>} wheelInfos - Wheel infos.
   * @param {Record<string, number>} firstFreeFamilyIndices - First free `(n)` index per attribute family.
   */
  constructor(fixture, wheelInfos, firstFreeFamilyIndices) {
    this.fixture = fixture;
    this.wheelInfos = wheelInfos;
    this.firstFreeFamilyIndices = firstFreeFamilyIndices;

    /** @type {Map<string, { templateKey: string, pixelKey: string }>} */
    this.matrixChannelOrigins = getMatrixChannelOrigins(fixture);

    /** @type {ModeLayout[]} */
    this.modeLayouts = fixture.modes.map((mode) => this._getModeLayout(mode));

    /** @type {Variant[]} */
    this.variants = this._getVariants();

    const { mainSkeleton, templateSkeletons, explicitSkeletons } = this._buildSkeletons();
    /** @type {Skeleton} */
    this.mainSkeleton = mainSkeleton;
    /** @type {Map<string, Skeleton>} Skeletons of template geometries, by template geometry key. */
    this.templateSkeletons = templateSkeletons;
    /** @type {Map<string, Skeleton>} Skeletons of pixels that are not instances of a template geometry, by pixel key. */
    this.explicitSkeletons = explicitSkeletons;

    /** @type {Map<string, Set<number>>} Mode indices in which each assignment key is used. */
    this.assignmentKeyModes = new Map();
    for (const [modeIndex, modeLayout] of this.modeLayouts.entries()) {
      for (const unit of modeLayout.units) {
        const key = getAssignmentKey(unit);
        if (!this.assignmentKeyModes.has(key)) {
          this.assignmentKeyModes.set(key, new Set());
        }
        this.assignmentKeyModes.get(key).add(modeIndex);
      }
    }

    /** @type {Map<string, Assignment>} */
    this.assignments = new Map();
    for (const modeLayout of this.modeLayouts) {
      for (const unit of modeLayout.units) {
        unit.assignment = this._assign(unit);
      }
    }

    /** @type {Map<GeometryNode, string>} Unique names of the template geometries' nodes. */
    this.templateNames = this._nameNodes();
  }

  /**
   * @param {Mode} mode - The mode.
   * @returns {ModeLayout} The mode's layout.
   */
  _getModeLayout(mode) {
    const units = getUnits(mode);

    for (const unit of units) {
      if (unit.pixelKey !== null) {
        unit.templateKey = this.matrixChannelOrigins.get(unit.main.key)?.templateKey ?? null;
      }
    }

    const matrixUnits = units.filter((unit) => unit.pixelKey !== null);
    const canUseReferences = matrixUnits.every(
      (unit) => unit.templateKey !== null && unit.main instanceof CoarseChannel,
    );

    const explicitPixelKeys = new Set();
    let templateClasses = [];
    if (canUseReferences) {
      templateClasses = this._getTemplateClasses(matrixUnits);
    }
    else {
      for (const unit of matrixUnits) {
        unit.role = 'explicit';
        explicitPixelKeys.add(unit.pixelKey);
      }
    }

    return {
      mode,
      units: units.filter((unit) => unit.role !== 'instance'),
      templateClasses,
      explicitPixelKeys,
      variantIndex: -1,
    };
  }

  /**
   * Groups matrix units into instances (one per pixel) and instances with the same relative channel layout into classes.
   * @param {Unit[]} matrixUnits - All units of a mode that belong to matrix channels.
   * @returns {TemplateClass[]} The template classes.
   */
  _getTemplateClasses(matrixUnits) {
    const unitsPerPixel = Map.groupBy(matrixUnits, (unit) => unit.pixelKey);

    const classes = new Map();
    for (const [pixelKey, pixelUnits] of unitsPerPixel) {
      const base = Math.min(...pixelUnits.flatMap((unit) => unit.offsets));
      const kind = this.fixture.matrix.pixelGroupKeys.includes(pixelKey) ? 'group' : 'pixel';
      const signature = [kind, ...pixelUnits.map(
        (unit) => `${unit.templateKey}:${unit.offsets.map((offset) => offset - base).join(',')}:${getChannelFingerprint(unit.main)}`,
      )].join('|');

      if (!classes.has(signature)) {
        classes.set(signature, { kind, instances: [] });
      }
      classes.get(signature).instances.push({ pixelKey, base, units: pixelUnits });
    }

    const countPerKind = { pixel: 0, group: 0 };
    return classes.values().map(({ kind, instances }) => {
      const sortedInstances = instances.toSorted((a, b) => a.base - b.base);
      const [firstInstance] = sortedInstances;
      const templateGeometryKey = `${kind}#${countPerKind[kind]}`;
      countPerKind[kind]++;

      for (const instance of sortedInstances) {
        for (const unit of instance.units) {
          unit.role = instance === firstInstance ? 'template' : 'instance';
          unit.templateGeometryKey = templateGeometryKey;
        }
      }

      return {
        templateGeometryKey,
        kind,
        instances: sortedInstances.map(({ pixelKey, base }) => ({
          pixelKey,
          breakOffset: base - firstInstance.base + 1,
        })),
        definitionUnits: firstInstance.units,
      };
    }).toArray();
  }

  /**
   * Assigns each mode to a geometry tree variant. Modes can share a tree if
   * their geometry references don't conflict.
   * @returns {Variant[]} The variants.
   */
  _getVariants() {
    /** @type {Variant[]} */
    const variants = [];

    for (const modeLayout of this.modeLayouts) {
      const references = new Map(modeLayout.templateClasses.map((templateClass) => [
        templateClass.templateGeometryKey,
        new Map(templateClass.instances.map(({ pixelKey, breakOffset }) => [pixelKey, breakOffset])),
      ]));

      let variant = variants.find((candidate) => isVariantCompatible(candidate, references, modeLayout.explicitPixelKeys));
      if (!variant) {
        variant = {
          index: variants.length,
          label: `Mode ${this.modeLayouts.indexOf(modeLayout) + 1}`,
          references: new Map(),
          explicitPixelKeys: new Set(),
          names: new Map(),
          referenceNames: new Map(),
        };
        variants.push(variant);
      }

      for (const [templateGeometryKey, instances] of references) {
        variant.references.set(templateGeometryKey, instances);
      }
      for (const pixelKey of modeLayout.explicitPixelKeys) {
        variant.explicitPixelKeys.add(pixelKey);
      }
      modeLayout.variantIndex = variant.index;
    }

    return variants;
  }

  /**
   * Builds the main skeleton, template geometry skeletons and explicit pixel skeletons.
   * @returns {{ mainSkeleton: Skeleton, templateSkeletons: Map<string, Skeleton>, explicitSkeletons: Map<string, Skeleton> }} The skeletons.
   */
  _buildSkeletons() {
    const unitsByRole = Map.groupBy(this.modeLayouts.flatMap((modeLayout) => modeLayout.units), (unit) => unit.role);
    const hasMatrixGeometry = this.modeLayouts.some(
      (modeLayout) => modeLayout.templateClasses.length > 0 || modeLayout.explicitPixelKeys.size > 0,
    );

    const mainSkeleton = new Skeleton({
      rootName: 'Body',
      prefix: '',
      ...this._getAxisNeeds(unitsByRole.get('main') ?? []),
      hasBeam: !hasMatrixGeometry,
    });
    mainSkeleton.root.kind = 'main';
    if (mainSkeleton.beam) {
      mainSkeleton.beam.isMainBeam = true;
    }

    const templateSkeletons = new Map();
    const templateUnits = Map.groupBy(unitsByRole.get('template') ?? [], (unit) => unit.templateGeometryKey);
    const templateKinds = new Map(this.modeLayouts.flatMap(
      (modeLayout) => modeLayout.templateClasses.map((templateClass) => [templateClass.templateGeometryKey, templateClass.kind]),
    ));
    for (const [templateGeometryKey, kind] of templateKinds) {
      const index = Number.parseInt(templateGeometryKey.split('#', 2)[1], 10);
      const baseName = kind === 'pixel' ? 'Pixel' : 'Pixel Group';
      const rootName = index === 0 ? baseName : `${baseName} ${index + 1}`;
      const skeleton = new Skeleton({
        rootName,
        prefix: `${rootName} `,
        ...this._getAxisNeeds(templateUnits.get(templateGeometryKey) ?? []),
        hasBeam: kind === 'pixel',
        rootIsBeam: true,
      });
      skeleton.root.kind = kind;
      templateSkeletons.set(templateGeometryKey, skeleton);
    }

    const explicitSkeletons = new Map();
    const explicitUnits = Map.groupBy(unitsByRole.get('explicit') ?? [], (unit) => unit.pixelKey);
    for (const [pixelKey, units] of explicitUnits) {
      const kind = this.fixture.matrix.pixelGroupKeys.includes(pixelKey) ? 'group' : 'pixel';
      const rootName = sanitizeName(kind === 'pixel' ? `Pixel ${pixelKey}` : `Pixel Group ${pixelKey}`);
      const skeleton = new Skeleton({
        rootName,
        prefix: `${rootName} `,
        ...this._getAxisNeeds(units),
        hasBeam: kind === 'pixel',
        rootIsBeam: true,
      });
      skeleton.root.kind = kind;
      explicitSkeletons.set(pixelKey, skeleton);
    }

    return { mainSkeleton, templateSkeletons, explicitSkeletons };
  }

  /**
   * @param {Unit[]} units - Units placed on a skeleton.
   * @returns {{ hasPan: boolean, hasTilt: boolean }} Which axes the skeleton needs.
   */
  _getAxisNeeds(units) {
    const attributes = new Set(units.flatMap(
      (unit) => getFunctionSpecs(unit, this.wheelInfos).map((spec) => spec.info.attribute),
    ));
    return {
      hasPan: attributes.has('Pan') || attributes.has('PanRotate'),
      hasTilt: attributes.has('Tilt') || attributes.has('TiltRotate'),
    };
  }

  /**
   * Decides the geometry node and attribute index of a unit's DMX channel, such
   * that DMX channel names are unique in every mode the unit is used in.
   * @param {Unit} unit - The unit.
   * @returns {Assignment} The assignment.
   */
  _assign(unit) {
    const key = getAssignmentKey(unit);

    if (this.assignments.has(key)) {
      return this.assignments.get(key);
    }

    const modeIndices = this.assignmentKeyModes.get(key);
    const specs = getFunctionSpecs(unit, this.wheelInfos);
    const mainSpec = getMainFunctionSpec(unit, specs);
    const mainAttribute = mainSpec.info.attribute;
    const family = mainAttribute.match(/^([A-Za-z]+)\(n\)/)?.[1];

    let node = this._getSkeleton(unit).getNodeForAttribute(mainAttribute.replace('(n)', '1'));
    let index = this.firstFreeFamilyIndices[family] ?? 1;
    const resolve = (attribute) => attribute.replace('(n)', () => String(index));
    const isTaken = () => {
      const users = node.usedAttributes.get(resolve(mainAttribute));
      return users !== undefined && !users.isDisjointFrom(modeIndices);
    };

    while (isTaken()) {
      if (mainAttribute.includes('(n)')) {
        index++;
        continue;
      }
      if (!node.collisionChildren.has(key)) {
        const collisionChild = new GeometryNode('Geometry', sanitizeName(unit.main.name));
        node.collisionChildren.set(key, node.addChild(collisionChild));
      }
      node = node.collisionChildren.get(key);
    }

    if (!node.usedAttributes.has(resolve(mainAttribute))) {
      node.usedAttributes.set(resolve(mainAttribute), new Set());
    }
    for (const modeIndex of modeIndices) {
      node.usedAttributes.get(resolve(mainAttribute)).add(modeIndex);
    }

    const assignment = {
      key,
      node,
      isTemplateNode: unit.role === 'template',
      logicalAttribute: resolve(mainAttribute),
      functions: specs.map((spec) => ({ ...spec, info: { ...spec.info, attribute: resolve(spec.info.attribute) } })),
    };
    this.assignments.set(key, assignment);
    return assignment;
  }

  /**
   * @param {Unit} unit - The unit.
   * @returns {Skeleton} The skeleton the unit is placed on.
   */
  _getSkeleton(unit) {
    if (unit.role === 'template') {
      return this.templateSkeletons.get(unit.templateGeometryKey);
    }
    if (unit.role === 'explicit') {
      return this.explicitSkeletons.get(unit.pixelKey);
    }
    return this.mainSkeleton;
  }

  /**
   * Gives every node a unique name in every variant.
   * @returns {Map<GeometryNode, string>} The names of the template geometries' nodes (variant nodes' names are stored in the variants).
   */
  _nameNodes() {
    const usedNames = new Set();

    // keep the plain name if it's still free, so that e.g. pixel names stay the same in all variants
    const claimName = (baseName, suffix) => getUniqueName(
      usedNames.has(baseName) ? `${baseName}${suffix}` : baseName,
      usedNames,
    );

    const nameTree = (root, variant, suffix) => {
      traverse(root, (node) => {
        variant.names.set(node, claimName(node.baseName, suffix));
      });
    };

    const nameVariantExtras = (variant, suffix) => {
      for (const [templateGeometryKey, instances] of variant.references) {
        for (const pixelKey of instances.keys()) {
          variant.referenceNames.set(`${templateGeometryKey}|${pixelKey}`, claimName(sanitizeName(pixelKey), suffix));
        }
      }
      for (const pixelKey of variant.explicitPixelKeys) {
        nameTree(this.explicitSkeletons.get(pixelKey).root, variant, suffix);
      }
    };

    // first variant gets the plain names, then template geometries, then other variants
    const [firstVariant, ...otherVariants] = this.variants;
    nameTree(this.mainSkeleton.root, firstVariant, '');
    nameVariantExtras(firstVariant, '');

    const templateNames = new Map();
    for (const skeleton of this.templateSkeletons.values()) {
      traverse(skeleton.root, (node) => {
        templateNames.set(node, getUniqueName(node.baseName, usedNames));
      });
    }

    for (const variant of otherVariants) {
      const suffix = ` (${variant.label})`;
      nameTree(this.mainSkeleton.root, variant, suffix);
      nameVariantExtras(variant, suffix);
    }

    return templateNames;
  }

  /**
   * @param {GeometryNode} node - A geometry node.
   * @param {Variant} variant - The variant.
   * @returns {string} The node's name in this variant.
   */
  getNodeName(node, variant) {
    return this.templateNames.get(node) ?? variant.names.get(node);
  }

  /**
   * @param {ModeLayout} modeLayout - A mode layout.
   * @returns {Variant} The mode's variant.
   */
  getVariant(modeLayout) {
    return this.variants[modeLayout.variantIndex];
  }

  /**
   * @param {Unit} unit - A unit.
   * @param {ModeLayout} modeLayout - The unit's mode layout.
   * @returns {string} The GDTF DMX channel name (`<geometry>_<attribute>`).
   */
  getDmxChannelName(unit, modeLayout) {
    const { node, logicalAttribute } = unit.assignment;
    return `${this.getNodeName(node, this.getVariant(modeLayout))}_${logicalAttribute}`;
  }
}

/**
 * @param {Variant} variant - An existing variant.
 * @param {Map<string, Map<string, number>>} references - The mode's geometry references.
 * @param {Set<string>} explicitPixelKeys - The mode's explicit pixel keys.
 * @returns {boolean} Whether the mode can use this variant's geometry tree.
 */
function isVariantCompatible(variant, references, explicitPixelKeys) {
  // a pixel is either referenced or has an explicit geometry, never both in one tree
  const isMixesReferencesAndExplicitPixels = (references.size > 0 && variant.explicitPixelKeys.size > 0)
    || (variant.references.size > 0 && explicitPixelKeys.size > 0);
  if (isMixesReferencesAndExplicitPixels) {
    return false;
  }

  const variantTemplatesByPixel = getTemplateGeometryKeysByPixel(variant.references);
  return references.entries().every(([templateGeometryKey, instances]) => {
    const variantInstances = variant.references.get(templateGeometryKey);
    const hasSameInstances = variantInstances === undefined || areMapsEqual(variantInstances, instances);
    const usesSameTemplates = instances.keys().every((pixelKey) => {
      const variantTemplate = variantTemplatesByPixel.get(pixelKey);
      return variantTemplate === undefined || variantTemplate === templateGeometryKey;
    });
    return hasSameInstances && usesSameTemplates;
  });
}

/**
 * @param {Map<string, Map<string, number>>} references - Break offsets per pixel key, per template geometry key.
 * @returns {Map<string, string>} The template geometry key of each referenced pixel.
 */
function getTemplateGeometryKeysByPixel(references) {
  const templateGeometryKeys = new Map();
  for (const [templateGeometryKey, instances] of references) {
    for (const pixelKey of instances.keys()) {
      templateGeometryKeys.set(pixelKey, templateGeometryKey);
    }
  }
  return templateGeometryKeys;
}

/**
 * @param {Map} a - First map.
 * @param {Map} b - Second map.
 * @returns {boolean} Whether both maps have the same entries in the same order.
 */
function areMapsEqual(a, b) {
  const entriesOfB = b.entries().toArray();
  return a.size === b.size && a.entries().every(([key, value], index) => {
    const [otherKey, otherValue] = entriesOfB[index];
    return key === otherKey && value === otherValue;
  });
}

/**
 * Matrix channels of different pixels can differ although they are created from
 * the same template channel, e.g. if a channel with the same key overrides one
 * pixel's resolved template channel. Only identical channels can share a template.
 * @param {CoarseChannel} channel - A matrix channel.
 * @returns {string} A fingerprint of everything that is exported, except for names and comments.
 */
function getChannelFingerprint(channel) {
  return JSON.stringify([
    omitProperties(channel.jsonObject, ['name', 'capability', 'capabilities']),
    channel.capabilities.map((capability) => omitProperties(capability.jsonObject, ['comment', 'helpWanted'])),
  ]);
}

/**
 * @param {object} object - An object.
 * @param {string[]} keys - Keys of properties to leave out.
 * @returns {object} A shallow copy of the object without the given properties.
 */
function omitProperties(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

/**
 * The function specs of a unit only depend on its main channel, so units with
 * the same main channel in the same geometry context share an assignment.
 * @param {Unit} unit - The unit.
 * @returns {string} The unit's assignment key.
 */
function getAssignmentKey(unit) {
  return unit.role === 'template' ? `template|${unit.templateGeometryKey}|${unit.templateKey}` : `${unit.role}|${unit.main.key}`;
}

/**
 * @param {Fixture} fixture - The fixture.
 * @returns {Map<string, { templateKey: string, pixelKey: string }>} Template channel key and pixel key for every matrix channel key.
 */
function getMatrixChannelOrigins(fixture) {
  const origins = new Map();
  if (!fixture.matrix) {
    return origins;
  }

  const pixelKeys = [...fixture.matrix.pixelKeys, ...fixture.matrix.pixelGroupKeys];
  for (const templateChannel of fixture.templateChannels) {
    for (const [templateKey, channelKeys] of templateChannel.possibleMatrixChannelKeys) {
      for (const [index, channelKey] of channelKeys.entries()) {
        origins.set(channelKey, { templateKey, pixelKey: pixelKeys[index] });
      }
    }
  }
  return origins;
}

/**
 * Groups a mode's channels into units (coarse channel with its fine channels).
 * @param {Mode} mode - The mode.
 * @returns {Unit[]} The units, ordered by offset.
 */
function getUnits(mode) {
  const channels = mode.channels;
  /** @type {Unit[]} */
  const units = [];
  const fineChannels = [];
  const fineSwitchingChannels = [];

  for (const [index, channel] of channels.entries()) {
    const offset = index + 1;

    if (channel instanceof FineChannel) {
      fineChannels.push({ channel, offset });
    }
    else if (channel instanceof SwitchingChannel && channel.switchToChannels.every((target) => target instanceof FineChannel)) {
      fineSwitchingChannels.push({ channel, offset });
    }
    else if (!(channel instanceof NullChannel) || offset === channels.length) {
      // unused channels don't need a DMX channel, except at the end to keep the mode's footprint
      units.push(new Unit(channel, offset));
    }
  }

  addFineChannels(units, fineChannels.toSorted((a, b) => a.channel.resolution - b.channel.resolution));
  addFineSwitchingChannels(units, fineSwitchingChannels);

  return units.toSorted((a, b) => a.offset - b.offset);
}

/**
 * Adds fine channels to the units of their coarse channels (or of switching channels that switch to their coarse channels).
 * @param {Unit[]} units - The mode's units, fine channels without a coarse channel are added as own units.
 * @param {{ channel: FineChannel, offset: number }[]} fineChannels - The mode's fine channels, ordered by resolution.
 */
function addFineChannels(units, fineChannels) {
  for (const { channel, offset } of fineChannels) {
    const coarseKey = channel.coarseChannel.key;
    const unit = units.find((candidate) => candidate.main.key === coarseKey)
      ?? units.find((candidate) => candidate.main instanceof SwitchingChannel && candidate.main.switchToChannelKeys.includes(coarseKey));

    if (unit) {
      unit.fineSlots.push({ offset, coarseKeys: new Set([coarseKey]) });
    }
    else {
      units.push(new Unit(channel, offset));
    }
  }
}

/**
 * Adds switching channels that switch between fine channels of another switching channel's targets to that switching channel's unit.
 * @param {Unit[]} units - The mode's units, switching channels without a matching coarse switching channel are added as own units.
 * @param {{ channel: SwitchingChannel, offset: number }[]} fineSwitchingChannels - The mode's switching channels whose targets are all fine channels.
 */
function addFineSwitchingChannels(units, fineSwitchingChannels) {
  for (const { channel, offset } of fineSwitchingChannels) {
    const unit = units.find((candidate) => isSwitchingFinePartOf(channel, candidate));
    if (unit) {
      unit.fineSlots.push({
        offset,
        coarseKeys: new Set(channel.switchToChannels.map((target) => target.coarseChannel.key)),
      });
      unit.fineSlots.sort((a, b) => a.offset - b.offset);
    }
    else {
      units.push(new Unit(channel, offset));
    }
  }
}

/**
 * @param {SwitchingChannel} fineSwitchingChannel - A switching channel whose targets are all fine channels.
 * @param {Unit} unit - A candidate unit.
 * @returns {boolean} Whether the switching channel is the fine part of the unit's switching channel.
 */
function isSwitchingFinePartOf(fineSwitchingChannel, unit) {
  const coarseSwitchingChannel = unit.main;
  if (!(coarseSwitchingChannel instanceof SwitchingChannel) || coarseSwitchingChannel.triggerChannel !== fineSwitchingChannel.triggerChannel) {
    return false;
  }

  const fineTriggerRanges = fineSwitchingChannel.triggerRanges;
  const coarseTriggerRanges = coarseSwitchingChannel.triggerRanges;
  return fineSwitchingChannel.switchToChannels.every((fineChannel) => {
    const coarseRanges = coarseTriggerRanges[fineChannel.coarseChannel.key];
    const fineRanges = fineTriggerRanges[fineChannel.key];
    return coarseRanges !== undefined && JSON.stringify(coarseRanges) === JSON.stringify(fineRanges);
  });
}

/**
 * @param {Unit} unit - The unit.
 * @param {Map<Wheel, WheelInfo>} wheelInfos - Wheel infos.
 * @returns {FunctionSpec[]} Function specs of all capabilities that are written into this unit's DMX channel.
 */
export function getFunctionSpecs(unit, wheelInfos) {
  const isSwitching = unit.main instanceof SwitchingChannel;

  return unit.sourceChannels.flatMap((sourceChannel) => {
    const switchTarget = isSwitching ? sourceChannel : null;

    if (sourceChannel instanceof CoarseChannel) {
      return sourceChannel.capabilities.map((capability) => ({
        info: getFunctionInfo(capability, wheelInfos),
        capability,
        sourceChannel,
        placeholderName: sourceChannel.name,
        switchTarget,
      }));
    }

    // NullChannel, or a fine channel that GDTF can't express on its own (its coarse channel isn't switched alongside)
    return {
      info: {
        attribute: 'NoFeature',
        physical: null,
        wheel: null,
        wheelSlotIndex: null,
        isColorMacro: false,
        fixedPhysical: null,
      },
      capability: null,
      sourceChannel,
      placeholderName: sourceChannel instanceof NullChannel ? 'No function' : sourceChannel.name,
      switchTarget,
    };
  });
}

/**
 * @param {Unit} unit - The unit.
 * @param {FunctionSpec[]} specs - The unit's function specs.
 * @returns {FunctionSpec} The spec whose attribute is used as the logical channel's attribute.
 */
function getMainFunctionSpec(unit, specs) {
  const preferredSpecs = unit.main instanceof SwitchingChannel
    ? specs.filter((spec) => spec.sourceChannel === unit.main.defaultChannel)
    : specs;
  return preferredSpecs.find((spec) => spec.info.attribute !== 'NoFeature')
    ?? specs.find((spec) => spec.info.attribute !== 'NoFeature')
    ?? specs[0];
}

/**
 * @param {GeometryNode} node - A geometry node.
 * @param {(node: GeometryNode) => void} callback - Called for every node in the tree.
 */
export function traverse(node, callback) {
  callback(node);
  for (const child of node.children) {
    traverse(child, callback);
  }
}
