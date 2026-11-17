import type { Routes } from '@angular/router';

/**
 * The admin area: one shell, four lazy areas. No area is loaded until an operator
 * opens it, and each one fetches only its own endpoints.
 */
export const ADMIN_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./admin-shell.component').then((m) => m.AdminShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'catalogo' },
      {
        path: 'catalogo',
        title: 'Catálogo · Administración',
        loadComponent: () =>
          import('./catalogue/admin-catalogue.component').then((m) => m.AdminCatalogueComponent),
      },
      {
        path: 'fuentes',
        title: 'Fuentes · Administración',
        loadComponent: () => import('./sources/admin-sources.component').then((m) => m.AdminSourcesComponent),
      },
      {
        path: 'epg',
        title: 'EPG · Administración',
        loadComponent: () => import('./epg/admin-epg.component').then((m) => m.AdminEpgComponent),
      },
      {
        path: 'operaciones',
        title: 'Operaciones · Administración',
        loadComponent: () =>
          import('./operations/admin-operations.component').then((m) => m.AdminOperationsComponent),
      },
    ],
  },
];
