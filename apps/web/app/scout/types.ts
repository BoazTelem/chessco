export type SearchResult = {
  id: string;
  federation_id: string;
  federation_player_id: string;
  name: string;
  country: string | null;
  title: string | null;
  rating_standard: number | null;
  rating_rapid: number | null;
  rating_blitz: number | null;
  birth_year: number | null;
  score: number;
  total_count: number;
};

export type TitleCategory =
  | 'GM'
  | 'WGM'
  | 'IM'
  | 'WIM'
  | 'FM'
  | 'WFM'
  | 'CM'
  | 'WCM'
  | 'NM'
  | 'WNM';
