import {
  getWorkingMemory,
  saveInteraction as saveInteractionToStore,
} from '@rebecca/memory';
import { AppDependencies } from '../types';

/**
 * Appends user and model interactions to the episodic buffer.
 *
 * @param deps - The application dependencies including the firestore service.
 * @param userId - The ID of the user.
 * @param userText - The text input from the user.
 * @param modelText - The text response from the model.
 * @param thought - Optional internal monologue generated alongside the reply.
 * @returns A promise that resolves when both interactions have been successfully saved.
 */
const saveInteraction = async (
  deps: AppDependencies,
  userId: string,
  userText: string,
  modelText: string,
  thought?: string,
): Promise<void> => {
  await saveInteractionToStore(deps.firestore, userId, userText, modelText, thought);
};

export {
  getWorkingMemory,
  saveInteraction,
};
