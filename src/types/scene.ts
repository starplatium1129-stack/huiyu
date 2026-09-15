export interface Scene {
  id: string;
  title?: string;
  prompt?: string;
  negativePrompt?: string;
  rating?: string;
}

export interface SceneBlueprint {
  id: string;
  sceneIds?: string[];
}
