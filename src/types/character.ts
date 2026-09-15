export interface Character {
  id: string;
  name: string;
  description?: string;
}

export interface Outfit {
  id: string;
  characterId?: string;
  name: string;
}
