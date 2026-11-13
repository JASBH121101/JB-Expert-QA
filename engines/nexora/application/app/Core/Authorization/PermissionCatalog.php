<?php

namespace App\Core\Authorization;

final class PermissionCatalog
{
    public static function labels(): array
    {
        return [
            'catalog.view' => 'Consultar productos del catálogo',
            'catalog.manage' => 'Crear, editar y publicar productos',
            'categories.manage' => 'Administrar categorías',
            'fields.manage' => 'Configurar grupos y campos dinámicos',
            'media.manage' => 'Gestionar fotografías',
            'reports.view' => 'Consultar reportes',
        ];
    }
}
