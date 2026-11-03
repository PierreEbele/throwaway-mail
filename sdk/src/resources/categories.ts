import { compact, seg, type HttpClient, type RequestOptions } from "../http.js";
import type { Category, CategoryColor } from "../types.js";

export interface CategoryParams {
  name?: string;
  color?: CategoryColor;
  pinned?: boolean;
  hidden?: boolean;
  /** Comma/space separated keywords; new addresses whose site matches land in this category. */
  autoMatch?: string | null;
  retentionDays?: number | null;
  position?: number;
}

const body = (p: CategoryParams) =>
  compact({
    name: p.name,
    color: p.color,
    pinned: p.pinned,
    hidden: p.hidden,
    auto_match: p.autoMatch,
    retention_days: p.retentionDays,
    position: p.position,
  });

export class Categories {
  constructor(private http: HttpClient) {}

  async list(opts?: RequestOptions): Promise<Category[]> {
    return (await this.http.get<{ categories: Category[] }>("/v1/categories", undefined, opts)).categories;
  }

  async create(p: CategoryParams & { name: string }, opts?: RequestOptions): Promise<Category> {
    const { hidden: _h, position: _p, ...rest } = p;
    return (await this.http.post<{ category: Category }>("/v1/categories", body(rest), opts)).category;
  }

  async update(id: string, p: CategoryParams, opts?: RequestOptions): Promise<Category> {
    return (await this.http.patch<{ category: Category }>(`/v1/categories/${seg(id)}`, body(p), opts)).category;
  }

  /** Addresses in the category become uncategorised. */
  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.delete(`/v1/categories/${seg(id)}`, opts);
  }

  async reorder(ids: string[], opts?: RequestOptions): Promise<void> {
    await this.http.post("/v1/categories/reorder", { ids }, opts);
  }
}
