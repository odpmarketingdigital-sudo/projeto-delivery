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
  PRIVACY_WHATSAPP_URL,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_WHATSAPP_URL,
} from "@/app/components/legal/legalContent";

export const metadata: Metadata = {
  title: "Política de Privacidade | ipepper",
  description:
    "Saiba como o ipepper coleta, usa, compartilha e protege os dados pessoais de estabelecimentos e usuários, em conformidade com a LGPD.",
  alternates: {
    canonical: "/privacidade",
  },
  openGraph: {
    title: "Política de Privacidade | ipepper",
    description:
      "Transparência sobre a coleta, o uso, o compartilhamento e a proteção de dados pessoais no ipepper.",
    siteName: PRODUCT_NAME,
    locale: "pt_BR",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Política de Privacidade | ipepper",
    description:
      "Transparência sobre a coleta, o uso, o compartilhamento e a proteção de dados pessoais no ipepper.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

const SECTIONS: LegalNavItem[] = [
  { id: "coleta-de-dados", title: "Coleta de Dados" },
  { id: "finalidade-do-uso", title: "Finalidade do Uso" },
  {
    id: "compartilhamento-com-terceiros",
    title: "Compartilhamento com Terceiros",
  },
  { id: "seguranca-da-informacao", title: "Segurança da Informação" },
  { id: "direitos-do-titular", title: "Direitos do Usuário (LGPD)" },
  { id: "contato", title: "Contato" },
];

export default function PrivacidadePage() {
  return (
    <LegalPageShell
      title="Política de Privacidade"
      eyebrow="Documentos legais"
      summary={`A ${PRODUCT_NAME} é uma plataforma de cardápio digital e pedidos via WhatsApp. Temos o compromisso de tratar dados pessoais com transparência, segurança e em conformidade com a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018 — LGPD). Esta política explica quais dados coletamos, por que coletamos, com quem compartilhamos e como você pode exercer seus direitos.`}
      sections={SECTIONS}
    >
      <LegalSection id="coleta-de-dados" number={1} title="Coleta de Dados">
        <p>
          Coletamos apenas os dados necessários para operar a plataforma e
          prestar o serviço contratado. As categorias abaixo descrevem o que é
          coletado e em qual momento.
        </p>

        <LegalSubheading>1.1. Dados de cadastro e identificação</LegalSubheading>
        <p>
          Informados por você no cadastro, na contratação do plano ou na
          atualização do perfil:
        </p>
        <LegalList>
          <li>
            Nome completo ou razão social e nome fantasia do estabelecimento;
          </li>
          <li>CPF/CNPJ do responsável legal;</li>
          <li>E-mail de acesso e de contato;</li>
          <li>Telefone/WhatsApp;</li>
          <li>
            Endereço do estabelecimento (CEP, logradouro, número, complemento,
            bairro, cidade e UF).
          </li>
        </LegalList>

        <LegalSubheading>1.2. Dados de transações e assinatura</LegalSubheading>
        <p>
          Plano contratado, status da assinatura, histórico de cobranças, valor,
          data, bandeira e os quatro últimos dígitos do cartão, além de
          identificadores da transação. Os dados completos do cartão (número
          integral e código de segurança) são coletados e armazenados
          diretamente pelos gateways{" "}
          <strong className="font-semibold text-gray-200">Stripe</strong> e{" "}
          <strong className="font-semibold text-gray-200">Asaas</strong>; o{" "}
          {PRODUCT_NAME} não tem acesso a essas informações.
        </p>

        <LegalSubheading>1.3. Dados de uso e navegação</LegalSubheading>
        <p>
          Registramos automaticamente informações técnicas para manter a
          segurança e o funcionamento do serviço, como endereço IP, data e hora
          de acesso, páginas e funcionalidades utilizadas, tipo de dispositivo,
          navegador, sistema operacional, identificadores de sessão e logs de
          erros. Utilizamos apenas cookies estritamente necessários para
          autenticação e segurança; não usamos cookies de publicidade.
        </p>

        <LegalSubheading>
          1.4. Dados de clientes finais do estabelecimento
        </LegalSubheading>
        <p>
          Nome, telefone, endereço de entrega, itens do pedido e observações
          inseridos pelo estabelecimento para viabilizar as vendas. Nesse
          contexto, o estabelecimento é o{" "}
          <strong className="font-semibold text-gray-200">controlador</strong>{" "}
          dos dados e a {PRODUCT_NAME} atua como{" "}
          <strong className="font-semibold text-gray-200">operadora</strong>,
          tratando as informações apenas conforme as instruções do lojista e o
          contrato de uso.
        </p>

        <LegalSubheading>
          1.5. Dados sensíveis e menores de idade
        </LegalSubheading>
        <p>
          Não solicitamos dados pessoais sensíveis (art. 5º, II, da LGPD) e
          pedimos que eles não sejam inseridos em campos de observação. A
          plataforma é destinada a maiores de 18 anos; não coletamos
          intencionalmente dados de crianças ou adolescentes.
        </p>
      </LegalSection>

      <LegalSection id="finalidade-do-uso" number={2} title="Finalidade do Uso">
        <p>
          Utilizamos os dados pessoais para as finalidades abaixo, sempre com
          base legal prevista na LGPD:
        </p>
        <LegalList>
          <li>
            <strong className="font-semibold text-gray-200">
              Cadastro, autenticação e gestão da conta
            </strong>{" "}
            — execução de contrato (art. 7º, V).
          </li>
          <li>
            <strong className="font-semibold text-gray-200">
              Gestão de assinaturas, cobranças e documentos fiscais
            </strong>{" "}
            — execução de contrato e cumprimento de obrigação legal (art. 7º,
            II).
          </li>
          <li>
            <strong className="font-semibold text-gray-200">
              Notificações de pedidos e comunicações operacionais
            </strong>{" "}
            por WhatsApp e e-mail, como confirmações, atualizações de status e
            alertas de conta — execução de contrato.
          </li>
          <li>
            <strong className="font-semibold text-gray-200">
              Suporte técnico e atendimento
            </strong>{" "}
            — execução de contrato e legítimo interesse (art. 7º, IX).
          </li>
          <li>
            <strong className="font-semibold text-gray-200">
              Segurança, prevenção a fraudes e melhoria do serviço
            </strong>{" "}
            — legítimo interesse, respeitadas as expectativas e liberdades do
            titular.
          </li>
          <li>
            <strong className="font-semibold text-gray-200">
              Comunicações de novidades e ofertas
            </strong>{" "}
            — consentimento (art. 7º, I), revogável a qualquer momento.
          </li>
          <li>
            <strong className="font-semibold text-gray-200">
              Cumprimento de obrigações legais e ordens de autoridades
            </strong>{" "}
            — obrigação legal ou regulatória.
          </li>
        </LegalList>
        <p>
          Não utilizamos os dados para finalidades incompatíveis com as
          descritas acima, nem para decisões automatizadas que afetem direitos
          dos titulares.
        </p>
      </LegalSection>

      <LegalSection
        id="compartilhamento-com-terceiros"
        number={3}
        title="Compartilhamento com Terceiros"
      >
        <p>
          Não vendemos nem alugamos dados pessoais. O compartilhamento ocorre
          apenas com parceiros essenciais à operação:
        </p>
        <LegalList>
          <li>
            <strong className="font-semibold text-gray-200">
              Gateways de pagamento — Stripe e Asaas:
            </strong>{" "}
            processamento de cobranças, assinaturas recorrentes, emissão de
            recibos e prevenção a fraudes.
          </li>
          <li>
            <strong className="font-semibold text-gray-200">
              Infraestrutura de hospedagem, banco de dados e autenticação:
            </strong>{" "}
            provedores de nuvem que armazenam e processam os dados em nosso
            nome, sob obrigações contratuais de confidencialidade e segurança.
          </li>
          <li>
            <strong className="font-semibold text-gray-200">
              WhatsApp/Meta:
            </strong>{" "}
            envio de mensagens e integração do canal de pedidos, conforme as
            políticas da plataforma.
          </li>
          <li>
            <strong className="font-semibold text-gray-200">
              Autoridades públicas:
            </strong>{" "}
            quando houver requisição legal, judicial ou regulatória.
          </li>
        </LegalList>
        <p>
          Alguns provedores podem tratar dados fora do Brasil. Nesses casos,
          exigimos salvaguardas contratuais e medidas compatíveis com os arts.
          33 a 36 da LGPD.
        </p>
      </LegalSection>

      <LegalSection
        id="seguranca-da-informacao"
        number={4}
        title="Segurança da Informação"
      >
        <p>
          Adotamos medidas técnicas e administrativas para proteger os dados
          contra acessos não autorizados, perda, alteração ou destruição,
          incluindo:
        </p>
        <LegalList>
          <li>
            criptografia em trânsito (HTTPS/TLS) em todas as comunicações com a
            plataforma;
          </li>
          <li>
            armazenamento de senhas com hash e gestão restrita de credenciais e
            chaves de acesso;
          </li>
          <li>
            controle de acesso baseado em papéis, limitando cada usuário às
            informações do próprio estabelecimento;
          </li>
          <li>
            registro de atividades, monitoramento de erros e rotinas de backup;
          </li>
          <li>
            políticas internas de confidencialidade e treinamento da equipe.
          </li>
        </LegalList>
        <p>
          Nenhum sistema é totalmente imune a incidentes. Caso ocorra um
          incidente de segurança relevante, comunicaremos os titulares afetados
          e a Autoridade Nacional de Proteção de Dados (ANPD), nos termos do
          art. 48 da LGPD.
        </p>
        <LegalCallout>
          <strong className="font-semibold text-white">
            Proteja a sua conta:
          </strong>{" "}
          use uma senha exclusiva e forte, não compartilhe suas credenciais e
          avise-nos imediatamente sobre qualquer acesso suspeito.
        </LegalCallout>
      </LegalSection>

      <LegalSection
        id="direitos-do-titular"
        number={5}
        title="Direitos do Usuário (LGPD)"
      >
        <p>
          Nos termos do art. 18 da LGPD, o titular pode solicitar a qualquer
          momento:
        </p>
        <LegalList>
          <li>confirmação da existência de tratamento e acesso aos dados;</li>
          <li>correção de dados incompletos, inexatos ou desatualizados;</li>
          <li>
            anonimização, bloqueio ou eliminação de dados desnecessários,
            excessivos ou tratados em desconformidade com a lei;
          </li>
          <li>
            portabilidade a outro fornecedor de serviço, mediante requisição
            expressa;
          </li>
          <li>eliminação dos dados tratados com base no consentimento;</li>
          <li>
            informação sobre as entidades com as quais compartilhamos dados;
          </li>
          <li>
            revogação do consentimento e oposição a tratamentos específicos;
          </li>
          <li>
            revisão de decisões tomadas unicamente com base em tratamento
            automatizado;
          </li>
          <li>petição à Autoridade Nacional de Proteção de Dados (ANPD).</li>
        </LegalList>

        <LegalSubheading>5.1. Como exercer seus direitos</LegalSubheading>
        <p>
          Envie um e-mail para{" "}
          <LegalLink href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </LegalLink>{" "}
          com o assunto{" "}
          <strong className="font-semibold text-gray-200">LGPD</strong>,
          informando seu nome, o e-mail cadastrado e o direito que deseja
          exercer. Podemos solicitar comprovação de identidade para evitar
          acessos indevidos. Responderemos em até{" "}
          <strong className="font-semibold text-gray-200">15 dias</strong>,
          contados do recebimento, salvo prazo legal diverso.
        </p>

        <LegalSubheading>5.2. Retenção e eliminação</LegalSubheading>
        <p>
          Mantemos os dados enquanto a conta estiver ativa e pelo tempo
          necessário às finalidades descritas. Após o encerramento, os registros
          podem ser conservados por até 5 anos para cumprimento de obrigações
          fiscais, contábeis e legais, e para o exercício regular de direitos
          (art. 16 da LGPD). Encerrados esses prazos, os dados são eliminados
          ou anonimizados de forma segura.
        </p>

        <LegalSubheading>5.3. Dados de clientes finais</LegalSubheading>
        <p>
          Pedidos de acesso, correção ou exclusão relativos a consumidores do
          estabelecimento devem ser dirigidos diretamente ao lojista, que é o
          controlador desses dados. Apoiaremos o estabelecimento no atendimento,
          na medida do possível técnico.
        </p>
      </LegalSection>

      <LegalSection id="contato" number={6} title="Contato">
        <p>
          Dúvidas sobre esta Política de Privacidade ou sobre o tratamento dos
          seus dados podem ser encaminhadas ao nosso Encarregado de Proteção de
          Dados (DPO):
        </p>
        <LegalCallout>
          <p className="font-semibold text-white">
            {PRODUCT_NAME} — Encarregado de Proteção de Dados (DPO)
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
          Para assuntos de privacidade, você também pode iniciar a conversa pelo
          WhatsApp com a mensagem já preenchida:{" "}
          <LegalLink href={PRIVACY_WHATSAPP_URL} external>
            falar sobre privacidade
          </LegalLink>
          .
        </p>
        <p>
          Esta política pode ser atualizada. A versão vigente é sempre a
          publicada nesta página, com a data de última atualização indicada no
          topo.
        </p>
      </LegalSection>
    </LegalPageShell>
  );
}
