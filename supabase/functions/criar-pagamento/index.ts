import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL_PSI = Deno.env.get("SUPABASE_URL")!;
const SITE_URL = "https://psi-online.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Resposta obrigatória para a requisição Preflight (CORS) do navegador
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders, status: 200 });
  }

  try {
    const supabase = createClient(
      SUPABASE_URL_PSI,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Token de autorização ausente." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Usuário não autenticado." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let body: { availability_id?: string; price?: number } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    if (!body.availability_id) {
      return new Response(
        JSON.stringify({ error: "availability_id é obrigatório." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Busca o ID do paciente vinculado ao profile do usuário
    const { data: patient, error: patientError } = await supabase
      .from("patients")
      .select("id")
      .eq("profile_id", user.id)
      .single();

    if (patientError || !patient) {
      return new Response(
        JSON.stringify({ error: "Paciente não encontrado para este usuário." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const valorConsulta = Number(body.price) || 170.00;
    // Formato exato que a webhook-mercadopago consome
    const externalReference = `${body.availability_id}|${patient.id}`;

    const ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN");
    if (!ACCESS_TOKEN) {
      return new Response(
        JSON.stringify({ error: "MP_ACCESS_TOKEN não configurado." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const preference = {
      items: [
        {
          title: "Consulta Psicológica - Psi Online",
          description: "Agendamento de consulta individual de psicologia",
          quantity: 1,
          currency_id: "BRL",
          unit_price: valorConsulta
        }
      ],
      external_reference: externalReference,
      notification_url: `${SUPABASE_URL_PSI}/functions/v1/webhook-mercadopago`,
      back_urls: {
        success: `${SITE_URL}/pagamento-sucesso.html`,
        failure: `${SITE_URL}/pagamento-falha.html`,
        pending: `${SITE_URL}/pagamento-pendente.html`
      },
      auto_return: "approved"
    };

    const resposta = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(preference)
    });

    const resultado = await resposta.json();

    if (!resposta.ok) {
      return new Response(
        JSON.stringify({ error: resultado.message || "Erro ao gerar preferência no Mercado Pago" }),
        { status: resposta.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Retorna o objeto do Mercado Pago contendo o init_point
    return new Response(JSON.stringify(resultado), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});