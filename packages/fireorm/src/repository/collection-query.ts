import {
    Firestore,
    Query,
    Timestamp,
    GeoPoint,
    DocumentReference,
    DocumentSnapshot,
    Transaction,
    QuerySnapshot,
    QueryDocumentSnapshot,
} from '@google-cloud/firestore'
import { FindOptionsUtils } from '../query-builder/find-options-utils'
import { getMetadataStorage } from '../metadata-storage'
import { EntitySchema } from '../common/entity-schema'
import { plainToClass, classToPlain } from 'class-transformer'
import { FindConditions } from '../query-builder/find-conditions'
import { FindManyOptions, FindOneOptions } from '../query-builder'
import * as dot from 'dot-object'
import * as jsonwebtoken from 'jsonwebtoken'

export interface CollectionQueryOption {
    collectionId?: string
    parentPath?: string
    tnx?: Transaction
}

export class CollectionQuery {
    constructor(protected firestore: Firestore, protected options: CollectionQueryOption = {}) {}

    protected getFindConditionsFromFindManyOptions<Entity>(
        optionsOrConditions: string | FindManyOptions<Entity> | FindConditions<Entity> | undefined,
    ): FindConditions<Entity> | undefined {
        if (!optionsOrConditions) return undefined

        if (FindOptionsUtils.isFindManyOptions(optionsOrConditions)) return optionsOrConditions.where as FindConditions<Entity>

        return optionsOrConditions as FindConditions<Entity>
    }

    protected getFindConditionsFromFindOneOptions<Entity>(
        optionsOrConditions: string | FindOneOptions<Entity> | FindConditions<Entity> | undefined,
    ): FindConditions<Entity> | undefined {
        if (!optionsOrConditions) return undefined

        if (FindOptionsUtils.isFindOneOptions(optionsOrConditions)) return optionsOrConditions.where as FindConditions<Entity>

        return optionsOrConditions as FindConditions<Entity>
    }

    transformToClass<Entity>(target: EntitySchema<Entity>, obj: any): Entity {
        return plainToClass(target, this.convertToJsObject(obj))
    }

    transformToPlain<Entity>(obj: Entity) {
        return this.convertToFirestoreObject(classToPlain(obj))
    }

    protected convertToJsObject(obj: any) {
        Object.keys(obj).forEach(key => {
            if (!obj[key]) return

            if (typeof obj[key] === 'object' && 'toDate' in obj[key]) {
                obj[key] = obj[key].toDate()
            } else if (obj[key].constructor.name === 'GeoPoint') {
                const { latitude, longitude } = obj[key]
                obj[key] = { latitude, longitude }
            } else if (obj[key].constructor.name === 'DocumentReference') {
                obj[key] = (obj[key] as DocumentReference).id
            } else if (typeof obj[key] === 'object') {
                this.convertToJsObject(obj[key])
            }
        })
        return obj
    }

    protected convertToFirestoreObject(obj: any) {
        Object.keys(obj).forEach(key => {
            if (obj[key] === undefined) {
                delete obj[key]
            }

            if (obj[key] && obj[key].$ref) {
                const { id, path } = obj[key].$ref
                obj[key] = this.firestore.collection(path).doc(id)
            } else if (obj[key] instanceof Array) {
                obj[key].forEach((_: any, index: number) => {
                    if (obj[key][index] === undefined) {
                        obj[key][index] = null
                    } else if (
                        typeof obj[key][index] === 'object' &&
                        !(obj[key][index] instanceof Date) &&
                        !(obj[key][index] instanceof Timestamp) &&
                        !(obj[key][index] instanceof GeoPoint)
                    ) {
                        this.convertToFirestoreObject(obj[key][index])
                    }
                })
            } else if (typeof obj[key] === 'object') {
                this.convertToFirestoreObject(obj[key])
            }
        })
        return obj
    }

    protected async loadRelations<Entity>(target: EntitySchema<Entity>, docs: (DocumentSnapshot | null)[], relations?: string[]) {
        const relationDocMapping = [] as any[]
        const relationDocCache: {
            [path: string]: Promise<DocumentSnapshot> | Promise<QuerySnapshot>
        } = {}

        const idPropName = getMetadataStorage().getIdPropName(target)
        const collectionPath = getMetadataStorage().getCollectionPath(target)

        const datas = docs.map((doc, index) => {
            if (!doc) return null
            const data = { ...doc.data(), [idPropName]: doc.id } as any

            if (relations && relations.length > 0) {
                const relationMetadataArgs = getMetadataStorage().relations.filter(item => item.target === target)

                relations.forEach(relation => {
                    const relationMetadataArg = relationMetadataArgs.find(item => item.propertyName === relation)
                    if (relationMetadataArg && relationMetadataArg.relationType === 'many-to-one') {
                        if (!relationDocMapping[index]) relationDocMapping.push({})

                        const field = dot.pick(relation, data)

                        if (field && field.constructor.name === 'DocumentReference') {
                            relationDocMapping[index][relation] = field.path

                            if (!relationDocCache[field.path]) {
                                relationDocCache[field.path] = field.get()
                            }
                        }
                    } else if (relationMetadataArg && relationMetadataArg.relationType === 'one-to-many') {
                        const relationCollectionPath = getMetadataStorage().getCollectionPath(relationMetadataArg.type())
                        const documentPath = collectionPath + '/' + data[idPropName]

                        if (!relationDocMapping[index]) relationDocMapping.push({})

                        relationDocMapping[index][relation] = documentPath

                        if (!relationDocCache[documentPath])
                            relationDocCache[documentPath] = this.firestore
                                .collection(relationCollectionPath)
                                .where(relationMetadataArg.inverseSide!, '==', this.firestore.doc(documentPath))
                                .get()
                    }
                })
            }
            return data
        })

        if (relationDocMapping.length) {
            const relationCachePromise = Object.keys(relationDocCache).map(async key => {
                return { key, value: await relationDocCache[key] }
            })
            const relationCachePromiseResult = await Promise.all(relationCachePromise)
            const relationCacheData = relationCachePromiseResult.reduce((object, current) => {
                if (current.value.constructor.name === 'QueryDocumentSnapshot') {
                    object[current.key] = { ...(current.value as QueryDocumentSnapshot).data() }
                }
                if (current.value.constructor.name === 'QuerySnapshot') {
                    object[current.key] = (current.value as QuerySnapshot).docs.map(doc => {
                        return { ...doc.data() }
                    })
                }
                return object
            }, {} as any)

            const relationDocDotMapping = dot.dot(relationDocMapping)
            Object.keys(relationDocDotMapping).forEach(key => {
                if (relationCacheData[relationDocDotMapping[key]]) {
                    dot.set(key, relationCacheData[relationDocDotMapping[key]], datas)
                }
            })
        }
        return datas.map(data => {
            if (!data) return data
            return this.transformToClass<Entity>(target, data)
        })
    }

    protected getQuery<Entity>(target: EntitySchema<Entity>): Query {
        if (this.options.collectionId) {
            return this.firestore.collectionGroup(this.options.collectionId)
        } else if (this.options.parentPath) {
            return this.firestore.collection(this.options.parentPath)
        } else {
            const collectionPath = getMetadataStorage().getCollectionPath(target)
            return this.firestore.collection(collectionPath)
        }
    }

    protected getDocumentRef<Entity>(target: EntitySchema<Entity>, id: string): DocumentReference {
        const collectionPath = getMetadataStorage().getCollectionPath(target)
        return this.firestore.collection(collectionPath).doc(id)
    }

    protected getIdPropName<Entity>(target: EntitySchema<Entity>) {
        return getMetadataStorage().getIdPropName(target)
    }

    async find<Entity>(target: EntitySchema<Entity>, options?: FindManyOptions<Entity>): Promise<Entity[]>
    async find<Entity>(target: EntitySchema<Entity>, conditions?: FindConditions<Entity>): Promise<Entity[]>
    async find<Entity>(
        target: EntitySchema<Entity>,
        optionsOrConditions?: FindManyOptions<Entity> | FindConditions<Entity>,
    ): Promise<Entity[]> {
        let selfQuery = this.getQuery(target)

        const where = this.getFindConditionsFromFindManyOptions(optionsOrConditions)
        if (where) {
            const relationMetadatas = getMetadataStorage().relations.filter(item => item.target === target)

            Object.keys(where).forEach(fieldPath => {
                const relationMetadata = relationMetadatas.find(item => item.propertyName === fieldPath)
                if (relationMetadata && !((where as any)[fieldPath] instanceof DocumentReference)) {
                    const relationCollectionPath = getMetadataStorage().getCollectionPath(relationMetadata.type)
                    const relationDocumentPath = relationCollectionPath + '/' + (where as any)[fieldPath]

                    selfQuery = selfQuery.where(fieldPath, '==', this.firestore.doc(relationDocumentPath))
                } else if ((where as any)[fieldPath].type) {
                    selfQuery = selfQuery.where(fieldPath, (where as any)[fieldPath].type, (where as any)[fieldPath].value)
                } else {
                    selfQuery = selfQuery.where(fieldPath, '==', (where as any)[fieldPath])
                }
            })
        }

        let relations: string[] = []
        if (FindOptionsUtils.isFindManyOptions(optionsOrConditions)) {
            if (optionsOrConditions.select) selfQuery = selfQuery.select(...(optionsOrConditions.select as any))

            if (optionsOrConditions.order)
                Object.keys(optionsOrConditions.order).forEach(fieldPath => {
                    selfQuery = selfQuery.orderBy(fieldPath, (optionsOrConditions.order as any)[fieldPath])
                })

            if (optionsOrConditions.limit) selfQuery = selfQuery.limit(optionsOrConditions.limit)

            if (optionsOrConditions.offset) selfQuery = selfQuery.offset(optionsOrConditions.offset)

            if (optionsOrConditions.startAfter) selfQuery = selfQuery.startAfter(...optionsOrConditions.startAfter)

            if (optionsOrConditions.startAt) selfQuery = selfQuery.startAt(...optionsOrConditions.startAt)

            if (optionsOrConditions.endBefore) selfQuery = selfQuery.endBefore(...optionsOrConditions.endBefore)

            if (optionsOrConditions.endAt) selfQuery = selfQuery.endAt(...optionsOrConditions.endAt)

            if (optionsOrConditions.relations) relations = optionsOrConditions.relations
        }

        const querySnapshot = await (this.options.tnx ? this.options.tnx.get(selfQuery) : selfQuery.get())
        return this.loadRelations(target, querySnapshot.docs, relations)
    }

    async findAndToken<Entity>(
        target: EntitySchema<Entity>,
        options?: FindManyOptions<Entity>,
    ): Promise<[string | undefined, Entity[]]>
    async findAndToken<Entity>(
        target: EntitySchema<Entity>,
        conditions?: FindConditions<Entity>,
    ): Promise<[string | undefined, Entity[]]>
    async findAndToken<Entity>(
        target: EntitySchema<Entity>,
        optionsOrConditions?: FindManyOptions<Entity> | FindConditions<Entity>,
    ): Promise<[string | undefined, Entity[]]> {
        const tokenObj: FindManyOptions<Entity> = {}
        const where = this.getFindConditionsFromFindManyOptions(optionsOrConditions)
        if (where) {
            tokenObj.where = where
        }
        if (FindOptionsUtils.isFindManyOptions(optionsOrConditions)) {
            if (optionsOrConditions.select) tokenObj.select = optionsOrConditions.select

            if (optionsOrConditions.order) tokenObj.order = optionsOrConditions.order

            if (optionsOrConditions.limit) tokenObj.limit = optionsOrConditions.limit
        }

        const documents = await this.find(target, optionsOrConditions)
        if (!tokenObj.limit || !tokenObj.order || tokenObj.limit > documents.length) {
            return [undefined, documents]
        }

        const idPropName = this.getIdPropName(target)
        const lastDocument = documents[documents.length - 1] as any
        const lastDocumentId = lastDocument[idPropName]
        const token = jsonwebtoken.sign({ ...tokenObj, lastDocumentId }, 'fireorm')

        return [token, documents]
    }

    async findByToken<Entity>(target: EntitySchema<Entity>, token: string): Promise<[string | undefined, Entity[]]> {
        let tokenObj: any
        try {
            tokenObj = jsonwebtoken.verify(token, 'fireorm')
            if (!tokenObj.lastDocumentId) {
                throw new Error()
            }
        } catch (error) {
            throw new Error('Invalid pagination token')
        }

        const { lastDocumentId, ...other } = tokenObj
        const startAfter = await this.getDocumentRef(target, lastDocumentId).get()
        if (!startAfter.exists) {
            throw new Error('Invalid pagination token')
        }
        return this.findAndToken<Entity>(target, {
            ...other,
            startAfter: [startAfter],
        } as FindManyOptions<Entity>)
    }

    async findOne<Entity>(target: EntitySchema<Entity>, options?: FindOneOptions<Entity>): Promise<Entity | undefined>
    async findOne<Entity>(target: EntitySchema<Entity>, conditions?: FindConditions<Entity>): Promise<Entity | undefined>
    async findOne<Entity>(
        target: EntitySchema<Entity>,
        optionsOrConditions?: FindOneOptions<Entity> | FindConditions<Entity>,
    ): Promise<Entity | undefined> {
        let selfQuery = this.getQuery(target)

        const where = this.getFindConditionsFromFindOneOptions(optionsOrConditions)
        if (where) {
            const relationMetadatas = getMetadataStorage().relations.filter(item => item.target === target)

            Object.keys(where).forEach(fieldPath => {
                const relationMetadata = relationMetadatas.find(item => item.propertyName === fieldPath)
                if (relationMetadata) {
                    const relationCollectionPath = getMetadataStorage().getCollectionPath(relationMetadata.type())
                    const relationDocumentPath = relationCollectionPath + '/' + (where as any)[fieldPath]

                    selfQuery = selfQuery.where(fieldPath, '==', this.firestore.doc(relationDocumentPath))
                } else if ((where as any)[fieldPath].type) {
                    selfQuery = selfQuery.where(fieldPath, (where as any)[fieldPath].type, (where as any)[fieldPath].value)
                } else {
                    selfQuery = selfQuery.where(fieldPath, '==', (where as any)[fieldPath])
                }
            })
        }

        let relations: string[] = []
        if (FindOptionsUtils.isFindOneOptions(optionsOrConditions)) {
            if (optionsOrConditions.select) selfQuery = selfQuery.select(...(optionsOrConditions.select as any))

            if (optionsOrConditions.startAfter) selfQuery = selfQuery.startAfter(...optionsOrConditions.startAfter)

            if (optionsOrConditions.startAt) selfQuery = selfQuery.startAt(...optionsOrConditions.startAt)

            if (optionsOrConditions.endBefore) selfQuery = selfQuery.endBefore(...optionsOrConditions.endBefore)

            if (optionsOrConditions.endAt) selfQuery = selfQuery.endAt(...optionsOrConditions.endAt)

            if (optionsOrConditions.relations) relations = optionsOrConditions.relations

            if (optionsOrConditions.order)
                Object.keys(optionsOrConditions.order).forEach(fieldPath => {
                    selfQuery = selfQuery.orderBy(fieldPath, (optionsOrConditions.order as any)[fieldPath])
                })
        }

        const querySnapshot = await (this.options.tnx ? this.options.tnx.get(selfQuery.limit(1)) : selfQuery.limit(1).get())
        if (querySnapshot.docs.length === 0 || !querySnapshot.docs[0].exists) return undefined

        const entities = await this.loadRelations(target, querySnapshot.docs, relations)
        return entities[0]
    }

    async findOneOrFail<Entity>(target: EntitySchema<Entity>, options?: FindOneOptions<Entity>): Promise<Entity>
    async findOneOrFail<Entity>(target: EntitySchema<Entity>, conditions?: FindConditions<Entity>): Promise<Entity>
    async findOneOrFail<Entity>(
        target: EntitySchema<Entity>,
        optionsOrConditions?: FindOneOptions<Entity> | FindConditions<Entity>,
    ): Promise<Entity> {
        return this.findOne<Entity>(target, optionsOrConditions).then(value => {
            if (value === undefined) {
                return Promise.reject(new Error(`Entity not found, entity: ${target.name}`))
            }
            return Promise.resolve(value)
        })
    }

    async findByIds<Entity>(
        target: EntitySchema<Entity>,
        id: string,
        options?: FindOneOptions<Entity>,
    ): Promise<Entity | undefined>
    async findByIds<Entity>(
        target: EntitySchema<Entity>,
        ids: string[],
        options?: FindOneOptions<Entity>,
    ): Promise<(Entity | undefined)[]>
    async findByIds<Entity>(
        target: EntitySchema<Entity>,
        idOrIds: string | string[],
        options?: FindOneOptions<Entity>,
    ): Promise<(Entity | undefined) | (Entity | undefined)[]> {
        if (this.options.collectionId) {
            throw new Error('findByIds not support CollectionGroup')
        }
        const collectionPath = this.options.parentPath ? this.options.parentPath : getMetadataStorage().getCollectionPath(target)
        const collectionRef = this.firestore.collection(collectionPath)
        const ids = idOrIds instanceof Array ? idOrIds : [idOrIds]

        const docRefs = ids.map(id => collectionRef.doc(id))
        const docSnapshots = await (this.options.tnx ? this.options.tnx.getAll(...docRefs) : this.firestore.getAll(...docRefs))

        const filterSnapShot = docSnapshots.map(v => {
            if (v.exists) return v
            return null
        })

        if (idOrIds instanceof Array) {
            return this.loadRelations(target, filterSnapShot, options && options.relations ? options.relations : [])
        } else {
            if (filterSnapShot.length === 0) return undefined

            const entities = await this.loadRelations(
                target,
                filterSnapShot,
                options && options.relations ? options.relations : [],
            )
            return entities[0]
        }
    }
}
