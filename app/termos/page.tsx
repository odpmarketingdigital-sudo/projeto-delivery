import type { Metadata } from "next";
import {
  LegalPageShell,
  type LegalNavItem,
} from "@/app/components/legal/LegalPageShell";
import {
  LegalCallout,
  LegalLink,
  LegalList,
  LegalSection,
  LegalSubheading,
} from "@/app/components/legal/LegalSection";
import {
  PRODUCT_NAME,
  SUPPORT_EMAIL,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_WHATSAPP_URL,
} from "@/app/components/legal/legalContent";

export const metadata: Metadata = {
  title: "Termos de Uso | Ipepper",
  description:
    "Condições de uso da plataforma Ipepper: cadastro, planos e pagamentos via Stripe e Asaas, disponibilidade, suporte e responsabilidades do estabelecimento.",
  openGraph: {
    title: "Termos de Uso | Ipepper",
    description:
      "Regras de utilização da plataforma Ipepper, planos, pagamentos, suporte e responsabilidades.",
    siteName: PRODUCT_NAME,
    locale: "pt_BR",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Termos de Uso | Ipepper",
    description:
      "Regras de utilização da plataforma Ipepper, planos, pagamentos, suporte e responsabilidades.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

const SECTIONS: LegalNavItem[] = [
  { id: "objeto-da-plataforma", title: "Objeto da Plataforma" },
  { id: "cadastro-e-responsabilidade", title: "Cadastro e Responsabilidade" },
  { id: "planos-e-pagamentos", title: "Planos e Pagamentos" },
  { id: "disponibilidade-e-suporte", title: "Disponibilidade e Suporte" },
  {
    id: "limitacao-de-responsabilidade",
    title: "Limitação de Responsabilidade",
  },
  { id: "rescisao-e-alteracoes", title: "Rescisão e Alterações" },
  { id: "contato", title: "Contato" },
];

export default function TermosPage() {
  return (
    <LegalPageShell
      title="Termos de Uso"
      eyebrow="Documentos legais"
      summary={`Estes Termos de Uso regulam o acesso e a utilização da plataforma ${PRODUCT_NAME}. Ao criar uma conta, contratar um plano ou utilizar qualquer funcionalidade, o estabelecimento declara ter lido e aceito integralmente estas condições e a Política de Privacidade.`}
      sections={SECTIONS}
    >
      <LegalSection
        id="objeto-da-plataforma"
        number={1}
        title="Objeto da Plataforma"
      >
        <p>
          O {PRODUCT_NAME} é uma plataforma de software como serviço (SaaS)
          para delivery e automação de atendimento via WhatsApp. A plataforma
          oferece, entre outras funcionalidades:
        </p>
        <LegalList>
          <li>
            cardápio digital com produtos, categorias, adicionais e cupons de
            desconto;
          </li>
          <li>
            recebimento e organização de pedidos em tempo real (kanban e
            tabela);
          </li>
          <li>dashboard, histórico de clientes e relatórios de vendas;</li>
          <li>
            envio e automação de mensagens pelo WhatsApp, incluindo
            notificações de status do pedido.
          </li>
        </LegalList>
        <p>
          O {PRODUCT_NAME} é uma ferramenta de gestão. A {PRODUCT_NAME}{" "}
          <strong className="font-semibold text-gray-200">não</strong> é
          restaurante, não produz, não vende, não entrega alimentos e não
          intermedeia pagamentos entre o estabelecimento e o consumidor final.
          O contrato de compra e venda é firmado exclusivamente entre o
          estabelecimento e o seu cliente.
        </p>
        <p>
          A integração com o WhatsApp depende da API e das políticas da
          Meta/WhatsApp Business. Limites, mudanças ou bloqueios impostos por
          esses provedores podem afetar funcionalidades e não são de
          responsabilidade da {PRODUCT_NAME}.
        </p>
      </LegalSection>

      <LegalSection
        id="cadastro-e-responsabilidade"
        number={2}
        title="Cadastro e Responsabilidade"
      >
        <LegalSubheading>2.1. Dados verdadeiros e atualizados</LegalSubheading>
        <p>
          Para usar a plataforma é necessário criar uma conta com informações
          verdadeiras, exatas e completas: nome ou razão social, CPF/CNPJ,
          e-mail, telefone/WhatsApp e endereço do estabelecimento. O usuário
          deve manter esses dados atualizados e responde pela veracidade das
          informações. Dados falsos ou de terceiros sem autorização podem levar
          à suspensão imediata da conta.
        </p>

        <LegalSubheading>2.2. Segurança das credenciais</LegalSubheading>
        <p>
          O estabelecimento é responsável por todas as atividades realizadas
          com suas credenciais de acesso. Mantenha a senha em sigilo, não
          compartilhe o acesso e comunique imediatamente qualquer uso não
          autorizado pelos canais de suporte.
        </p>

        <LegalSubheading>2.3. Uso adequado e legal</LegalSubheading>
        <p>Ao utilizar o {PRODUCT_NAME}, o estabelecimento compromete-se a:</p>
        <LegalList>
          <li>
            cumprir a legislação brasileira, incluindo o Código de Defesa do
            Consumidor, a LGPD e as normas sanitárias aplicáveis;
          </li>
          <li>
            respeitar as políticas da Meta/WhatsApp e não enviar mensagens não
            solicitadas (spam);
          </li>
          <li>
            não usar a plataforma para conteúdo ilícito, discriminatório,
            fraudulento ou que viole direitos de terceiros;
          </li>
          <li>
            não tentar acessar dados de outros estabelecimentos, burlar limites
            de uso ou comprometer a segurança da infraestrutura;
          </li>
          <li>
            não realizar engenharia reversa, cópia ou exploração comercial do
            software sem autorização escrita.
          </li>
        </LegalList>

        <LegalSubheading>2.4. Dados dos clientes finais</LegalSubheading>
        <p>
          O estabelecimento é o controlador dos dados pessoais dos seus clientes
          (nome, telefone, endereço e pedidos) e deve possuir base legal para
          tratá-los, manter a própria política de privacidade e atender às
          solicitações dos titulares. A {PRODUCT_NAME} atua como operadora,
          conforme a{" "}
          <LegalLink href="/privacidade">Política de Privacidade</LegalLink>.
        </p>

        <LegalSubheading>2.5. Conteúdo enviado</LegalSubheading>
        <p>
          O estabelecimento garante possuir os direitos sobre textos, fotos,
          marcas e demais conteúdos publicados no cardápio e concede à{" "}
          {PRODUCT_NAME} licença limitada para exibi-los exclusivamente na
          prestação do serviço.
        </p>
      </LegalSection>

      <LegalSection
        id="planos-e-pagamentos"
        number={3}
        title="Planos e Pagamentos"
      >
        <LegalSubheading>3.1. Planos e preços</LegalSubheading>
        <p>
          Os planos, limites e preços vigentes são os exibidos na página
          inicial e em{" "}
          <LegalLink href="/painel/assinatura">Assinatura</LegalLink> dentro do
          painel. Os valores são cobrados em reais (BRL) e podem incluir
          tributos conforme a legislação aplicável.
        </p>

        <LegalSubheading>3.2. Formas de pagamento</LegalSubheading>
        <p>
          As cobranças são processadas pelos gateways{" "}
          <strong className="font-semibold text-gray-200">Stripe</strong> e{" "}
          <strong className="font-semibold text-gray-200">Asaas</strong>, por
          cartão de crédito, Pix ou boleto, conforme disponibilidade. Os dados
          de pagamento são tratados diretamente por esses provedores, que
          possuem certificação PCI-DSS; o {PRODUCT_NAME} não armazena o número
          completo do cartão.
        </p>

        <LegalSubheading>3.3. Renovação automática</LegalSubheading>
        <p>
          As assinaturas são recorrentes e renovadas automaticamente ao fim de
          cada ciclo. O cancelamento interrompe as renovações futuras, mas não
          gera devolução dos valores já pagos; o acesso permanece ativo até o
          fim do período contratado.
        </p>

        <LegalSubheading>3.4. Reajustes</LegalSubheading>
        <p>
          Reajustes de preço serão comunicados com antecedência mínima de 30
          dias por e-mail ou pelo painel. O estabelecimento pode cancelar antes
          de o novo valor entrar em vigor.
        </p>

        <LegalSubheading>3.5. Inadimplência e suspensão</LegalSubheading>
        <p>
          Em caso de falha na cobrança, o estabelecimento será notificado para
          regularizar o pagamento. Persistindo a inadimplência, o acesso ao
          painel poderá ser suspenso a partir do vencimento e a assinatura
          poderá ser cancelada após 30 dias corridos sem pagamento, sem
          prejuízo da cobrança dos valores devidos e dos encargos previstos em
          lei.
        </p>

        <LegalSubheading>3.6. Reembolsos</LegalSubheading>
        <p>
          Não há reembolso de períodos já iniciados, salvo nas hipóteses
          previstas em lei — incluindo o direito de arrependimento de 7 dias do
          art. 49 do Código de Defesa do Consumidor, quando aplicável — ou em
          caso de falha comprovada e não sanada do serviço.
        </p>

        <LegalSubheading>3.7. Documentos fiscais</LegalSubheading>
        <p>
          Recibos e notas fiscais podem ser solicitados pelo e-mail{" "}
          <LegalLink href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </LegalLink>
          .
        </p>
      </LegalSection>

      <LegalSection
        id="disponibilidade-e-suporte"
        number={4}
        title="Disponibilidade e Suporte"
      >
        <LegalSubheading>4.1. Disponibilidade</LegalSubheading>
        <p>
          Empregamos esforços comercialmente razoáveis para manter a plataforma
          disponível 24 horas por dia, 7 dias por semana, mas não garantimos
          operação ininterrupta ou livre de erros. O serviço é fornecido no
          estado em que se encontra e conforme as funcionalidades
          disponibilizadas no momento do uso.
        </p>

        <LegalSubheading>4.2. Manutenções</LegalSubheading>
        <p>
          Manutenções programadas serão comunicadas com antecedência sempre que
          possível. Intervenções emergenciais de segurança ou correção podem
          ocorrer sem aviso prévio, pelo menor tempo necessário.
        </p>

        <LegalSubheading>4.3. Canais e horário de atendimento</LegalSubheading>
        <p>
          O suporte da {PRODUCT_NAME} é prestado por e-mail (
          <LegalLink href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</LegalLink>
          ) e WhatsApp (
          <LegalLink href={SUPPORT_WHATSAPP_URL} external>
            {SUPPORT_PHONE_DISPLAY}
          </LegalLink>
          ), de segunda a sexta, das 9h às 18h (horário de Brasília), com prazo
          de resposta de até 1 dia útil. Não há atendimento presencial.
        </p>

        <LegalCallout>
          Para agilizar o atendimento, informe o nome do estabelecimento, o
          e-mail da conta e o passo a passo do problema, com capturas de tela
          quando possível.
        </LegalCallout>
      </LegalSection>

      <LegalSection
        id="limitacao-de-responsabilidade"
        number={5}
        title="Limitação de Responsabilidade"
      >
        <LegalSubheading>5.1. Responsabilidade do estabelecimento</LegalSubheading>
        <p>
          O estabelecimento é o único responsável pelos produtos e serviços que
          comercializa, incluindo descrição, preços, qualidade, prazo de preparo
          e entrega, taxas, atendimento, trocas, reembolsos, alvarás, licenças
          sanitárias e obrigações tributárias. Eventuais reclamações de
          consumidores devem ser tratadas diretamente pelo estabelecimento.
        </p>

        <LegalSubheading>5.2. Serviços de terceiros</LegalSubheading>
        <p>
          Não respondemos por indisponibilidades, falhas ou mudanças de
          serviços de terceiros dos quais a plataforma depende, como
          WhatsApp/Meta, Stripe, Asaas, provedores de nuvem, operadoras de
          internet e telefonia e concessionárias de energia elétrica.
        </p>

        <LegalSubheading>5.3. Limites</LegalSubheading>
        <p>
          Na máxima extensão permitida pela legislação aplicável, a{" "}
          {PRODUCT_NAME} não responde por lucros cessantes, perda de
          oportunidade, danos indiretos ou prejuízos decorrentes de uso
          inadequado da plataforma, salvo dolo ou culpa grave.
        </p>

        <LegalSubheading>5.4. Teto de responsabilidade</LegalSubheading>
        <p>
          Quando admitido em lei, a responsabilidade total da {PRODUCT_NAME}{" "}
          fica limitada ao valor efetivamente pago pelo estabelecimento nos 12
          meses anteriores ao evento que originou o dano. Nenhuma cláusula
          deste documento afasta direitos irrenunciáveis do consumidor
          previstos no Código de Defesa do Consumidor.
        </p>

        <LegalSubheading>5.5. Registros do estabelecimento</LegalSubheading>
        <p>
          A plataforma não substitui controles fiscais, contábeis ou
          operacionais próprios do estabelecimento. Recomendamos manter
          registros independentes das vendas realizadas.
        </p>
      </LegalSection>

      <LegalSection
        id="rescisao-e-alteracoes"
        number={6}
        title="Rescisão e Alterações"
      >
        <LegalSubheading>6.1. Cancelamento pelo estabelecimento</LegalSubheading>
        <p>
          O cancelamento pode ser solicitado a qualquer momento pelo painel, em{" "}
          <LegalLink href="/painel/assinatura">Assinatura</LegalLink>, ou pelo
          e-mail{" "}
          <LegalLink href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</LegalLink>
          , sem multa. O acesso permanece até o fim do período já pago e não há
          renovação automática após o cancelamento.
        </p>

        <LegalSubheading>6.2. Rescisão pela Ipepper</LegalSubheading>
        <p>
          Podemos suspender ou encerrar a conta, mediante aviso quando possível,
          em caso de descumprimento destes Termos, uso ilícito, inadimplência,
          risco à segurança da plataforma ou determinação legal.
        </p>

        <LegalSubheading>6.3. Efeitos do encerramento</LegalSubheading>
        <p>
          Após o encerramento, o acesso é bloqueado. O estabelecimento pode
          solicitar a exportação dos seus dados em até 30 dias; depois disso, os
          registros são eliminados ou anonimizados respeitando os prazos legais
          de guarda, como os 5 anos para obrigações fiscais.
        </p>

        <LegalSubheading>6.4. Alterações destes Termos</LegalSubheading>
        <p>
          Estes Termos podem ser atualizados para refletir mudanças no produto,
          na legislação ou em práticas de mercado. A versão vigente é sempre a
          publicada nesta página, com a data de atualização. Alterações
          materiais serão comunicadas com antecedência mínima de 15 dias por
          e-mail ou pelo painel; o uso da plataforma após a vigência implica
          aceite.
        </p>

        <LegalSubheading>6.5. Legislação e foro</LegalSubheading>
        <p>
          Estes Termos são regidos pelas leis brasileiras. Fica eleito o foro
          do domicílio do estabelecimento quando este for consumidor, nos
          termos do Código de Defesa do Consumidor e, nos demais casos, o foro
          da comarca da sede da {PRODUCT_NAME}.
        </p>
      </LegalSection>

      <LegalSection id="contato" number={7} title="Contato">
        <p>
          Dúvidas sobre estes Termos, pedidos de suporte ou solicitações de
          cancelamento podem ser encaminhados pelos canais abaixo:
        </p>
        <LegalCallout>
          <p className="font-semibold text-white">
            {PRODUCT_NAME} — Suporte
          </p>
          <ul className="mt-3 space-y-2">
            <li>
              E-mail:{" "}
              <LegalLink href={`mailto:${SUPPORT_EMAIL}`}>
                {SUPPORT_EMAIL}
              </LegalLink>
            </li>
            <li>
              Telefone/WhatsApp:{" "}
              <LegalLink href={SUPPORT_WHATSAPP_URL} external>
                {SUPPORT_PHONE_DISPLAY}
              </LegalLink>
            </li>
            <li>
              Atendimento: segunda a sexta, das 9h às 18h (horário de Brasília).
            </li>
          </ul>
        </LegalCallout>
        <p>
          Para assuntos de privacidade e proteção de dados, consulte a{" "}
          <LegalLink href="/privacidade">Política de Privacidade</LegalLink> ou
          escreva para o nosso Encarregado de Proteção de Dados (DPO) pelo
          e-mail informado acima.
        </p>
        <p>
          Ao utilizar o {PRODUCT_NAME}, você declara que leu, compreendeu e
          aceita estes Termos de Uso.
        </p>
      </LegalSection>
    </LegalPageShell>
  );
}
