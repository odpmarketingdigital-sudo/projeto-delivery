import type { AdminUser, Order, Product, ProductOptionGroup } from "@/lib/types";

// Ordem de exibição das categorias no cardápio.
// Mantida como sugestão de ordem; a lista exibida é derivada
// dinamicamente dos produtos (preparo para cadastro dinâmico).
export const categoryOrder = [
  "Lanches",
  "Pizzas",
  "Acompanhamentos",
  "Bebidas",
] as const;

export type CategoryName = (typeof categoryOrder)[number];

const lancheOptionGroups: ProductOptionGroup[] = [
  {
    id: "tipo-carne",
    title: "Tipo de Carne",
    required: true,
    minSelect: 1,
    maxSelect: 1,
    options: [
      { id: "carne-industrial-120g", name: "Carne Industrial 120g", price: 0 },
      { id: "carne-gourmet-240g", name: "Carne Gourmet 240g", price: 5 },
    ],
  },
  {
    id: "adicionais",
    title: "Adicionais",
    required: false,
    options: [
      { id: "queijo-extra", name: "Queijo extra", price: 2 },
      { id: "alface", name: "Alface", price: 1 },
      { id: "tomate", name: "Tomate", price: 2 },
      { id: "bacon-crocante", name: "Bacon crocante", price: 5 },
    ],
  },
];

export const products: Product[] = [
  {
    id: "p1",
    nome: "X-Salada Artesanal",
    descricao:
      "Pão brioche, blend 160g, queijo prato, alface, tomate e maionese da casa.",
    preco: 26.9,
    categoria: "Lanches",
    image_url: "/x-salada-artesanal.webp",
    option_groups: lancheOptionGroups,
  },
  {
    id: "p2",
    nome: "X-Bacon Duplo",
    descricao:
      "Pão artesanal, 2x blends 160g, muito bacon crocante e queijo cheddar duplo.",
    preco: 34.9,
    categoria: "Lanches",
    image_url: "/x-bacon-duplo.webp",
    option_groups: lancheOptionGroups,
  },
  {
    id: "p3",
    nome: "Porção de Batata Frita",
    descricao:
      "Porção de batatas rústicas fritas, crocantes por fora e macias por dentro.",
    preco: 18.0,
    categoria: "Acompanhamentos",
    image_url: "/porcao-de-batata-frita.webp",
  },
  {
    id: "p4",
    nome: "Pizza Margherita Broto",
    descricao:
      "Molho de tomate artesanal, muçarela, tomate fatiado e manjericão fresco.",
    preco: 29.9,
    categoria: "Pizzas",
    image_url: "/pizza-margherita-broto.webp",
  },
  {
    id: "p5",
    nome: "Pizza Calabresa Média",
    descricao:
      "Molho de tomate, muçarela, fatias de calabresa artesanal e cebola roxa.",
    preco: 42.0,
    categoria: "Pizzas",
    image_url: "/pizza-calabresa-media.webp",
  },
  {
    id: "p6",
    nome: "Suco Natural de Laranja 500ml",
    descricao: "Suco 100% natural de laranja, espremido na hora.",
    preco: 9.0,
    categoria: "Bebidas",
    image_url: "/suco-natural-de-laranja-500ml.webp",
  },
  {
    id: "p7",
    nome: "Refrigerante Lata 350ml",
    descricao: "Refrigerante lata gelado (Coca-Cola ou Guaraná).",
    preco: 6.0,
    categoria: "Bebidas",
    image_url: "/refrigerente-lata-350ml.webp",
  },
];

export const mockOrders: Order[] = [
  {
    id: "o1",
    numero: 1041,
    cliente: "Ana Souza",
    itens: [
      { produto: "X-Salada Artesanal", quantidade: 2, preco: 22.9 },
      { produto: "Refrigerente Lata 350ml", quantidade: 1, preco: 6.5 },
    ],
    total: 52.3,
    status: "pendente",
    data: "08/10/2026",
    hora: "19:12",
  },
  {
    id: "o2",
    numero: 1042,
    cliente: "Carlos Lima",
    itens: [
      { produto: "Pizza Calabresa (Média)", quantidade: 1, preco: 34.9 },
      { produto: "Refrigerente Lata 350ml", quantidade: 2, preco: 6.5 },
    ],
    total: 47.9,
    status: "pendente",
    data: "08/10/2026",
    hora: "19:18",
  },
  {
    id: "o3",
    numero: 1043,
    cliente: "Marta Oliveira",
    itens: [
      { produto: "Brownie com Sorvete", quantidade: 1, preco: 14.9 },
      { produto: "Suco Natural de Laranja 500ml", quantidade: 1, preco: 12.0 },
    ],
    total: 26.9,
    status: "preparando",
    data: "08/10/2026",
    hora: "19:05",
  },
  {
    id: "o4",
    numero: 1044,
    cliente: "João Pereira",
    itens: [
      { produto: "Porção de Batata Frita", quantidade: 3, preco: 18.9 },
      { produto: "Refrigerente Lata 350ml", quantidade: 2, preco: 6.5 },
    ],
    total: 69.7,
    status: "preparando",
    data: "08/10/2026",
    hora: "18:57",
  },
  {
    id: "o5",
    numero: 1045,
    cliente: "Fernanda Dias",
    itens: [
      { produto: "X-Bacon Duplo", quantidade: 1, preco: 26.9 },
      { produto: "X-Salada Artesanal", quantidade: 1, preco: 22.9 },
    ],
    total: 49.8,
    status: "entrega",
    data: "08/10/2026",
    hora: "18:44",
  },
  {
    id: "o6",
    numero: 1046,
    cliente: "Ricardo Alves",
    itens: [{ produto: "Pizza Margherita (Broto)", quantidade: 1, preco: 32.9 }],
    total: 32.9,
    status: "entrega",
    data: "08/10/2026",
    hora: "18:30",
  },
  {
    id: "o7",
    numero: 1047,
    cliente: "Patrícia Nunes",
    itens: [
      { produto: "Brownie com Sorvete", quantidade: 2, preco: 14.9 },
      { produto: "Suco Natural de Laranja 500ml", quantidade: 1, preco: 12.0 },
    ],
    total: 41.8,
    status: "finalizado",
    data: "08/10/2026",
    hora: "18:10",
  },
  {
    id: "o8",
    numero: 1048,
    cliente: "Bruno Martins",
    itens: [
      { produto: "X-Bacon Duplo", quantidade: 1, preco: 26.9 },
      { produto: "Porção de Batata Frita", quantidade: 1, preco: 18.9 },
      { produto: "Refrigerente Lata 350ml", quantidade: 2, preco: 6.5 },
    ],
    total: 58.8,
    status: "finalizado",
    data: "08/10/2026",
    hora: "17:52",
  },
];

// Usuários administrativos para o módulo de Gestão de Usuários (Super Admin).
// Dados de demonstração (MVP) — a lista é manipulada apenas no estado local.
// As senhas abaixo são fictícias e existem apenas para simular o botão
// "Copiar Acesso" (envio de credenciais ao dono do restaurante via WhatsApp).
export const mockUsers: AdminUser[] = [
  {
    id: "u1",
    name: "André de Paula",
    email: "andredepaulacloud@gmail.com",
    role: "super_admin",
    status: "ativo",
    created_at: "01/02/2026",
    establishment: "Fuego Delivery (Matriz)",
    password: "Fuego@2026admin",
  },
  {
    id: "u2",
    name: "Gerente La Fuego",
    email: "gerente@fuego.com.br",
    role: "admin",
    status: "ativo",
    created_at: "15/03/2026",
    establishment: "La Fuego Hamburgueria",
    password: "Fuego@2026ger",
  },
  {
    id: "u3",
    name: "João Cliente",
    email: "joao@email.com",
    role: "cliente",
    status: "inativo",
    created_at: "20/05/2026",
  },
];

