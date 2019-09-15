import { Inject } from '@nestjs/common'
import { EntitySchema } from '@isman/fireorm'
import { getCollectionToken, getCollectionGroupToken } from './fireorm.utils';
import { FIRESTORE_INSTANCT } from './fireorm.constants';

export const InjectCollectionRepo = <T extends { id: string }>(entity: EntitySchema<T>) => Inject(getCollectionToken(entity.name))

export const InjectFirestore = () => Inject(FIRESTORE_INSTANCT)
