import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { createDebug } from './utils/debug.js';

const log = createDebug('user');

export interface UserProfile {
  id: string;
  createdAt: number;
  name?: string;
}

const USER_CONFIG_DIR = '.fan_bot';
const USER_CONFIG_FILE = 'user.json';

export async function getUserId(): Promise<string> {
  const profile = await getOrCreateUserProfile();
  return profile.id;
}

export async function getOrCreateUserProfile(): Promise<UserProfile> {
  const configDir = join(process.cwd(), USER_CONFIG_DIR);
  const configPath = join(configDir, USER_CONFIG_FILE);

  if (existsSync(configPath)) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const profile = JSON.parse(content) as UserProfile;
      log.debug(`Loaded user profile: ${profile.id}`);
      return profile;
    } catch (error) {
      log.warn(`Failed to read user config: ${error}`);
    }
  }

  const newProfile: UserProfile = {
    id: `user-${crypto.randomUUID()}`,
    createdAt: Date.now(),
  };

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(newProfile, null, 2), 'utf-8');
  log.info(`Created new user profile: ${newProfile.id}`);

  return newProfile;
}

export async function updateUserProfile(
  updates: Partial<Omit<UserProfile, 'id' | 'createdAt'>>,
): Promise<UserProfile> {
  const profile = await getOrCreateUserProfile();
  const updated = { ...profile, ...updates };

  const configDir = join(process.cwd(), USER_CONFIG_DIR);
  const configPath = join(configDir, USER_CONFIG_FILE);
  await writeFile(configPath, JSON.stringify(updated, null, 2), 'utf-8');

  return updated;
}
