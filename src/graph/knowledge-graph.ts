/**
 * Knowledge Graph Manager
 * High-level operations for the entity-relation-observation graph
 */

import {
  EngramDatabase,
  Entity,
  Observation,
  Relation,
} from "../storage/database.js";

export interface EntityWithDetails extends Entity {
  observations: Observation[];
  relationsFrom: Array<Relation & { targetEntity: Entity }>;
  relationsTo: Array<Relation & { sourceEntity: Entity }>;
}

export interface GraphTraversal {
  rootEntity: Entity;
  entities: Entity[];
  relations: Relation[];
  observations: Observation[];
}

export class KnowledgeGraph {
  constructor(private db: EngramDatabase) {}

  // ============ Entity Operations ============

  /**
   * Get or create an entity by name
   */
  getOrCreateEntity(
    name: string,
    type: Entity["type"] = "person"
  ): Entity {
    const existing = this.db.findEntityByName(name);
    if (existing) return existing;
    return this.db.createEntity(name, type);
  }

  /**
   * Get entity with all its observations and relations
   */
  getEntityDetails(nameOrId: string): EntityWithDetails | null {
    // Try to find by name first, then by ID
    let entity = this.db.findEntityByName(nameOrId);
    if (!entity) {
      entity = this.db.getEntity(nameOrId);
    }
    if (!entity) return null;

    const observations = this.db.getEntityObservations(entity.id);
    const relations = this.db.getEntityRelations(entity.id, "both");

    const relationsFrom: Array<Relation & { targetEntity: Entity }> = [];
    const relationsTo: Array<Relation & { sourceEntity: Entity }> = [];

    for (const rel of relations) {
      if (rel.from_entity === entity.id) {
        const target = this.db.getEntity(rel.to_entity);
        if (target) {
          relationsFrom.push({ ...rel, targetEntity: target });
        }
      } else {
        const source = this.db.getEntity(rel.from_entity);
        if (source) {
          relationsTo.push({ ...rel, sourceEntity: source });
        }
      }
    }

    return {
      ...entity,
      observations,
      relationsFrom,
      relationsTo,
    };
  }

  /**
   * Find entities matching a query
   */
  findEntities(query: string, type?: Entity["type"]): Entity[] {
    return this.db.searchEntities(query, type);
  }

  /**
   * List all entities of a type
   */
  listEntities(type?: Entity["type"], limit: number = 100): Entity[] {
    return this.db.listEntities(type, limit);
  }

  // ============ Observation Operations ============

  /**
   * Add an observation to an entity
   */
  addObservation(
    entityNameOrId: string,
    content: string,
    sourceMemoryId?: string,
    confidence: number = 1.0
  ): Observation {
    const entity = this.db.findEntityByName(entityNameOrId) ||
      this.db.getEntity(entityNameOrId);

    if (!entity) {
      throw new Error(`Entity not found: ${entityNameOrId}`);
    }

    return this.db.addObservation(entity.id, content, sourceMemoryId || null, confidence);
  }

  /**
   * Get all observations for an entity
   */
  getObservations(entityNameOrId: string): Observation[] {
    const entity = this.db.findEntityByName(entityNameOrId) ||
      this.db.getEntity(entityNameOrId);

    if (!entity) return [];

    return this.db.getEntityObservations(entity.id);
  }

  // ============ Relation Operations ============

  /**
   * Create or get a relation between two entities
   */
  relate(
    fromNameOrId: string,
    toNameOrId: string,
    type: string,
    properties?: Record<string, unknown>
  ): Relation {
    const fromEntity = this.db.findEntityByName(fromNameOrId) ||
      this.db.getEntity(fromNameOrId);
    const toEntity = this.db.findEntityByName(toNameOrId) ||
      this.db.getEntity(toNameOrId);

    if (!fromEntity) throw new Error(`Entity not found: ${fromNameOrId}`);
    if (!toEntity) throw new Error(`Entity not found: ${toNameOrId}`);

    // Check if relation already exists
    const existing = this.db.findRelation(fromEntity.id, toEntity.id, type);
    if (existing) return existing;

    return this.db.createRelation(fromEntity.id, toEntity.id, type, properties || null);
  }

  /**
   * Get relations for an entity
   */
  getRelations(
    entityNameOrId: string,
    direction: "from" | "to" | "both" = "both"
  ): Relation[] {
    const entity = this.db.findEntityByName(entityNameOrId) ||
      this.db.getEntity(entityNameOrId);

    if (!entity) return [];

    return this.db.getEntityRelations(entity.id, direction);
  }

  // ============ Graph Traversal ============

  /**
   * Traverse the graph from an entity
   */
  traverse(
    entityNameOrId: string,
    depth: number = 2,
    relationTypes?: string[]
  ): GraphTraversal | null {
    const entity = this.db.findEntityByName(entityNameOrId) ||
      this.db.getEntity(entityNameOrId);

    if (!entity) return null;

    const result = this.db.traverse(entity.id, depth, relationTypes);

    return {
      rootEntity: entity,
      ...result,
    };
  }

  /**
   * Find memories related to an entity by traversing the graph
   */
  findRelatedMemoryIds(
    entityNameOrId: string,
    depth: number = 2
  ): string[] {
    const traversal = this.traverse(entityNameOrId, depth);
    if (!traversal) return [];

    const memoryIds = new Set<string>();

    for (const obs of traversal.observations) {
      if (obs.source_memory_id) {
        memoryIds.add(obs.source_memory_id);
      }
    }

    return Array.from(memoryIds);
  }
}
